/**
 * Static-address archive: archive an address you no longer give out, list the archive, restore.
 *
 *   CRYPTOLIKE_API_KEY_ID=ck_test_… CRYPTOLIKE_API_SECRET=… npx tsx examples/static-address-archive.ts <address-id>
 *
 * An archived address is never deleted or re-issued. It leaves real-time scanning, but the
 * platform checks it for incoming transfers regularly (every 24 h by default); a transfer found
 * is credited as usual and restores the address automatically (webhook static_address.restored,
 * reason "deposit") — see examples/express-webhook.ts.
 */
import { CryptoLike, ApiError } from "cryptolike";

const api = new CryptoLike(); // credentials from the environment
const id = process.argv[2];
if (!id) throw new Error("usage: static-address-archive.ts <address-id>");

const archived = await api.archiveStaticAddress(id, `archive-${id}`); // a repeat is a no-op
console.log("archived", archived.address, archived.archived_at, archived.archive_reason);

// The archive: same filters as the address list (search, coin_id, customer_id), newest first.
for await (const a of api.iterateArchivedStaticAddresses({ customer_id: archived.customer_id })) {
  console.log("in the archive:", a.id, a.address, a.archive_reason); // manual | auto
}

try {
  const active = await api.restoreStaticAddress(id, `restore-${id}`);
  console.log("active again", active.address, active.restored_at);
} catch (e) {
  // The customer got another active address for this coin meanwhile: one active address per
  // (customer, coin). Archive that one first if this is the address to keep.
  if (e instanceof ApiError && e.status === 409) console.log("restore refused; active address:", e.details?.active_address_id);
  else throw e;
}
