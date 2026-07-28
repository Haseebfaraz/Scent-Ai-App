// scripts/build-region-summary.cjs
//
// Precomputes ProductRegionSummary from OrderHistory — the offline batch job Phase 12 calls for
// ("Consider creating summary tables ... optional materialized summary tables"). A live groupBy
// scoped to a broad tier like country="United States" (87% of the 936,819-row table) measured
// ~12s per query in testing; doing that aggregation once here, instead of on every chat request,
// is what makes analyzeCustomerProductCandidates (app/services/orderHistoryAnalysis.server.js)
// fast. City tier is deliberately NOT precomputed here — a single real city's row count is always
// small enough (thousands, not hundreds of thousands) to query live.
//
// Upserts use one multi-row raw INSERT ... ON CONFLICT per batch (not one Prisma upsert() call per
// row inside a $transaction) — an earlier version did the latter and Render's Postgres closed the
// connection partway through a 32k-row batch (P1017), almost certainly from holding one open
// transaction across hundreds of individual round trips for too long.
//
// Run with: node scripts/build-region-summary.cjs
// Re-run whenever OrderHistory changes (e.g. after re-running seed-notes.cjs).

const crypto = require('crypto');
const { PrismaClient, Prisma } = require('@prisma/client');
const prisma = new PrismaClient();

const UPSERT_BATCH_SIZE = 1000;

async function upsertRows(scope, rows) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const values = batch.map(
      (r) => Prisma.sql`(${crypto.randomUUID()}, ${r.normalizedProductName}, ${scope}, ${r.scopeValue}, ${r.orderCount}, ${r.distinctCustomerCount}, ${r.repeatCustomerCount}, now())`,
    );
    await prisma.$executeRaw`
      INSERT INTO "ProductRegionSummary"
        (id, "normalizedProductName", scope, "scopeValue", "orderCount", "distinctCustomerCount", "repeatCustomerCount", "updatedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("normalizedProductName", scope, "scopeValue")
      DO UPDATE SET
        "orderCount" = EXCLUDED."orderCount",
        "distinctCustomerCount" = EXCLUDED."distinctCustomerCount",
        "repeatCustomerCount" = EXCLUDED."repeatCustomerCount",
        "updatedAt" = now()
    `;
    console.log(`    upserted ${Math.min(i + UPSERT_BATCH_SIZE, rows.length)}/${rows.length}`);
  }
}

// Groups by (normalizedProductName, <column>), computing order/distinct-customer/repeat-customer
// counts in one pass via a customer-level CTE (cheaper than a correlated subquery per group).
// customerKeyHash IS NULL rows (~30 of 936,819 — missing source "Name") are excluded from all
// three counts; that's a ~0.003% undercount, not worth a second pass to fold back in.
async function buildScopeSummary(column, scope) {
  const rows = await prisma.$queryRawUnsafe(`
    WITH customer_order_counts AS (
      SELECT "normalizedProductName", "${column}" AS scope_value, "customerKeyHash", COUNT(*) AS cnt
      FROM "OrderHistory"
      WHERE "normalizedProductName" IS NOT NULL
        AND "${column}" IS NOT NULL
        AND "customerKeyHash" IS NOT NULL
      GROUP BY "normalizedProductName", "${column}", "customerKeyHash"
    )
    SELECT "normalizedProductName", scope_value,
           SUM(cnt)::int AS order_count,
           COUNT(*)::int AS distinct_customer_count,
           COUNT(*) FILTER (WHERE cnt > 1)::int AS repeat_customer_count
    FROM customer_order_counts
    GROUP BY "normalizedProductName", scope_value
  `);

  console.log(`  ${scope}: ${rows.length} (product, ${column}) pairs`);
  await upsertRows(
    scope,
    rows.map((r) => ({
      normalizedProductName: r.normalizedProductName,
      scopeValue: r.scope_value,
      orderCount: r.order_count,
      distinctCustomerCount: r.distinct_customer_count,
      repeatCustomerCount: r.repeat_customer_count,
    })),
  );
}

// "season" scope is NOT region-restricted — it answers "how much does this product sell in this
// season overall," a signal independent of the customer's own region (see SCORE_WEIGHTS.sameSeason
// in app/utils/fragranceScoring.js).
async function buildSeasonSummary() {
  await buildScopeSummary('season', 'season');
}

// Classification is really a product attribute (its fragrance style), not a regional statistic, so
// this stores one global tally per product rather than one per region — the highest-count
// classification per product is picked at read time in orderHistoryAnalysis.server.js.
async function buildClassificationSummary() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT "normalizedProductName", "classification" AS scope_value, COUNT(*)::int AS order_count
    FROM "OrderHistory"
    WHERE "normalizedProductName" IS NOT NULL AND "classification" IS NOT NULL
    GROUP BY "normalizedProductName", "classification"
  `);
  console.log(`  classification_global: ${rows.length} (product, classification) pairs`);
  await upsertRows(
    'classification_global',
    rows.map((r) => ({
      normalizedProductName: r.normalizedProductName,
      scopeValue: r.scope_value,
      orderCount: r.order_count,
      distinctCustomerCount: 0,
      repeatCustomerCount: 0,
    })),
  );
}

async function main() {
  console.log('Building country summary...');
  await buildScopeSummary('countryName', 'country');
  console.log('Building state summary...');
  await buildScopeSummary('stateName', 'state');
  console.log('Building season summary...');
  await buildSeasonSummary();
  console.log('Building classification summary...');
  await buildClassificationSummary();
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
