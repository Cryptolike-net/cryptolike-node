/**
 * Express webhook receiver: verify the signature over the RAW body, deduplicate by event_id,
 * acknowledge fast, process afterwards (https://cryptolike.net/docs/webhooks §3–§4).
 *
 *   CRYPTOLIKE_WEBHOOK_SECRET=whsec_… npx tsx examples/express-webhook.ts
 */
import express from "express";
import { verifyWebhook, isWebhookEvent, StaticAddressEvent, WebhookVerificationError, type WebhookEvent } from "cryptolike";

const secret = process.env.CRYPTOLIKE_WEBHOOK_SECRET;
if (!secret) throw new Error("CRYPTOLIKE_WEBHOOK_SECRET is not set");

const app = express();
const seen = new Set<string>(); // use your database in production

// express.raw keeps the bytes as received — a JSON body parser would re-serialise them and break the signature.
app.post("/hooks/cryptolike", express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
  let event: WebhookEvent;
  try {
    event = verifyWebhook(req.headers, req.body as Buffer, secret); // default tolerance: 300 s
  } catch (e) {
    if (e instanceof WebhookVerificationError) return res.sendStatus(e.reason === "invalid_signature" ? 401 : 400);
    throw e;
  }

  if (seen.has(event.event_id)) return res.sendStatus(200); // duplicate delivery — already handled
  seen.add(event.event_id);

  // Acknowledge first, then act. `data` is the full state of the object at `created_at`;
  // deliveries may arrive out of order — decide by `data.invoice.status`, not by arrival.
  res.sendStatus(200);

  // Static-address archive events come typed (no casts).
  if (isWebhookEvent(event, StaticAddressEvent.ArchiveWarning)) {
    // No incoming transfers since inactive_since: archived automatically after archive_after.
    console.log("will be archived", event.data.address.customer_id, event.data.archive_after);
    return;
  }
  if (isWebhookEvent(event, StaticAddressEvent.Archived)) {
    console.log("archived", event.data.address.id, event.data.reason); // manual | auto — stop showing it to the customer
    return;
  }
  if (isWebhookEvent(event, StaticAddressEvent.Restored)) {
    // reason "deposit": a transfer reached the archived address; it is credited with its own deposit.* events.
    console.log("active again", event.data.address.id, event.data.reason, event.data.deposit?.txid);
    if (event.data.conflict_with) console.log("the customer has two active addresses; archive one:", event.data.conflict_with);
    return;
  }

  switch (event.type) {
    case "invoice.paid": {
      const invoice = (event.data as { invoice: { id: string; order_id: string | null; paid_amount: string } }).invoice;
      console.log("paid", invoice.order_id, invoice.paid_amount);
      // fulfil the order
      break;
    }
    case "invoice.expired":
    case "invoice.cancelled":
      console.log(event.type, (event.data as { invoice: { id: string } }).invoice.id);
      break;
    case "ping":
      break; // test event from the cabinet
    default:
      console.log("unhandled", event.type);
  }
});

app.listen(3000, () => console.log("listening on :3000"));
