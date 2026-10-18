/**
 * Create a payment and print the page to send the payer to.
 *
 *   CRYPTOLIKE_API_KEY_ID=ck_test_… CRYPTOLIKE_API_SECRET=… npx tsx examples/create-payment.ts
 *
 * Runs on your server. The browser only ever receives `checkout_url` / the invoice id.
 */
import { CryptoLike, ApiError } from "cryptolike";

const api = new CryptoLike(); // credentials from the environment

try {
  const invoice = await api.invoices.create(
    { amount: "10.50", currency: "USD", order_id: "A-1001", return_url: "https://shop.example/orders/A-1001" },
    "order-A-1001", // Idempotency-Key: your order id — a retry never creates a second payment
  );
  console.log("send the customer to", invoice.checkout_url);

  // The payer chooses the coin on the payment page among the ones you allow for this invoice
  // (here: every stablecoin you offer for invoices). Omit allowed_coin_ids to offer them all.
  const { currencies } = await api.currencies.list();
  const stable = currencies
    .filter((c) => c.invoice_enabled !== false && !c.maintenance && ["USDT", "USDC"].includes(c.ticker))
    .map((c) => c.id);
  if (stable.length > 0) {
    const choice = await api.invoices.create(
      { amount: "10.50", currency: "USD", order_id: "A-1002", allowed_coin_ids: stable }, // 422 no_allowed_coins: none offered for invoices in USD
      "order-A-1002",
    );
    console.log("payer picks one of", choice.allowed_coin_ids?.length ?? "all", "coins at", choice.checkout_url);
  }

  const detail = await api.invoices.get(invoice.id);
  console.log("status", detail.status, "events", detail.events.length);
} catch (e) {
  if (e instanceof ApiError) {
    // Stable machine code + human message; `field` for validation errors.
    console.error(`API ${e.status} ${e.code}${e.field ? ` (${e.field})` : ""}: ${e.message}`);
  } else {
    throw e;
  }
}
