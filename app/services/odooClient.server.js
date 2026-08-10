// Minimal Odoo connectivity check — a read-only ping, nothing else. No auth, no inventory lookup,
// no Prisma, no Shopify calls. This is the healthCheck() piece of the Odoo client described in the
// integration requirements brief; searchRead/batchRead/real inventory lookups are deliberately not
// built yet — approved only up through proving connectivity.
// Server-only (.server.js) — Odoo must never be reachable from the browser/theme JS.
const ODOO_PING_URL = process.env.ODOO_PING_URL || "https://the-dua-brand-sandbox-5aug-35949002.dev.odoo.com/api/v1/dua-ai/ping";

export async function pingOdoo() {
  const startedAt = Date.now();
  try {
    const response = await fetch(ODOO_PING_URL, { method: "GET", headers: { Accept: "application/json" } });
    const body = await response.text();
    return { ok: response.ok, status: response.status, durationMs: Date.now() - startedAt, body };
  } catch (error) {
    return { ok: false, status: null, durationMs: Date.now() - startedAt, error: error?.message || String(error) };
  }
}
