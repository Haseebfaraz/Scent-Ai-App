// One-off connectivity check — DUA backend -> Odoo /ping, nothing else. No inventory lookup, no
// auth, no Prisma, no Shopify. Run with: node scripts/test-odoo-connection.js
// The actual call lives in app/services/odooClient.server.js (pingOdoo) — this script is just a
// thin CLI wrapper around it so it's exercised the same way real app code will call it.
import { pingOdoo } from "../app/services/odooClient.server.js";

async function main() {
  const url = process.env.ODOO_PING_URL || "https://the-dua-brand-sandbox-12aug-36292701.dev.odoo.com/api/v1/dua-ai/ping";
  console.log("ODOO_PING_STARTED", { url });

  const result = await pingOdoo();

  if (result.error) {
    console.error("ODOO_PING_FAILED", { message: result.error });
    process.exitCode = 1;
    return;
  }

  console.log("ODOO_PING_RESPONSE", {
    status: result.status,
    ok: result.ok,
    durationMs: result.durationMs,
    body: result.body,
  });

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main();
