// Import Notes-Extraction-Separated-with-Oil-SKU update.xlsx -> OdooOilMapping.
// This sheet IS the master catalog source (same Handle/Title/Notes/PricePer5ml/Collection shape
// FragranceProduct was originally imported from), now with up to 4 "Oil SKU" columns appended.
// A single-inspiration product has exactly ONE populated SKU column (F). An existing finished
// Hybrid/Tribrid/Quadbrid combination row has one SKU per real component spread across F/G/H/I —
// that combo itself never gets its own mapping (it has no single physical oil of its own); its real
// components get mapped individually via their OWN separate rows elsewhere in this same sheet.
// Matches by Handle (exact) — never fuzzy name matching, per spec. Idempotent (upsert).
import XLSX from "xlsx";
import prisma from "../app/db.server.js";
import { normalizeProductName } from "../app/utils/fragranceNormalization.js";

const XLSX_PATH = process.argv[2] || "C:/Users/duate/Desktop/shop-chat-agent/data/Notes-Extraction-Separated-with-Oil-SKU update.xlsx";
const SKU_COLUMN_INDICES = [5, 6, 7, 8]; // F, G, H, I

async function main() {
  const wb = XLSX.readFile(XLSX_PATH);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["Notes-Extraction-Separated"], { header: 1 }).slice(1);
  console.log(`Read ${rows.length} data rows.`);

  const products = await prisma.fragranceProduct.findMany({ select: { id: true, handle: true, normalizedTitle: true, title: true } });
  const byHandle = new Map(products.filter((p) => p.handle).map((p) => [p.handle, p]));
  const byNormalizedTitle = new Map(products.map((p) => [p.normalizedTitle, p]));
  console.log(`Real catalog: ${products.length} FragranceProduct rows.`);

  const created = [];
  const updated = [];
  const skipped = []; // { handle, title, reason }

  for (const row of rows) {
    const [handle, title] = row;
    if (!handle || !title) { skipped.push({ handle, title, reason: "MALFORMED_ROW" }); continue; }

    const skus = SKU_COLUMN_INDICES.map((i) => row[i]).filter(Boolean);
    if (skus.length === 0) { skipped.push({ handle, title, reason: "NO_SKU" }); continue; }
    if (skus.length > 1) { skipped.push({ handle, title, reason: "MULTI_COMPONENT_COMBO", skus }); continue; }
    const sku = skus[0].trim();

    const product = byHandle.get(handle) || byNormalizedTitle.get(normalizeProductName(title));
    if (!product) { skipped.push({ handle, title, reason: "NO_CATALOG_MATCH" }); continue; }

    const existing = await prisma.odooOilMapping.findUnique({ where: { fragranceProductId: product.id } });
    await prisma.odooOilMapping.upsert({
      where: { fragranceProductId: product.id },
      create: { fragranceProductId: product.id, odooSku: sku, active: true },
      update: { odooSku: sku, active: true },
    });
    (existing ? updated : created).push({ title: product.title, sku });
  }

  console.log(`\nCreated: ${created.length}`);
  console.log(`Updated: ${updated.length}`);
  console.log(`Skipped: ${skipped.length}`);
  const byReason = {};
  for (const s of skipped) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
  console.log("Skip reasons:", JSON.stringify(byReason, null, 2));
  console.log("\nFirst 15 NO_CATALOG_MATCH (for review):");
  console.log(JSON.stringify(skipped.filter((s) => s.reason === "NO_CATALOG_MATCH").slice(0, 15), null, 2));

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
