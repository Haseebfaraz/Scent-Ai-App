#!/usr/bin/env node
// Read-only backend lookup: shows what real DUA products actually sit behind any recommendation
// the chatbot has shown a customer — the customer-facing name/description is all they ever see;
// this prints the real internal products (productsJson) that name maps to, plus its status/
// confidence/evidenceScope, straight from the FragranceRecommendation table.
//
// Usage:
//   node scripts/inspect-recommendation.cjs                          # last 15 recommendations, any conversation
//   node scripts/inspect-recommendation.cjs --conversation=<id>      # every recommendation for one conversation
//   node scripts/inspect-recommendation.cjs --name="Sophisticated Story"  # most recent match for that name
//   node scripts/inspect-recommendation.cjs --limit=30               # override the default row count

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const limit = args.limit ? parseInt(args.limit, 10) : 15;

  const where = {};
  if (args.conversation) where.conversationId = args.conversation;

  const rows = await prisma.fragranceRecommendation.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: args.name ? 200 : limit, // scan further back when hunting a specific name
    select: {
      id: true,
      conversationId: true,
      status: true,
      combinationType: true,
      createdAt: true,
      customerFacingJson: true,
      productsJson: true,
      evidenceScope: true,
      scoreJson: true,
      shopifyProductId: true,
    },
  });

  const filtered = args.name
    ? rows.filter((r) => r.customerFacingJson?.customerFacingName === args.name).slice(0, 1)
    : rows;

  if (!filtered.length) {
    console.log("No matching recommendations found.");
    return;
  }

  for (const r of filtered) {
    console.log("---");
    console.log("id:", r.id, "| conversationId:", r.conversationId);
    console.log("customerFacingName:", r.customerFacingJson?.customerFacingName || "(none)");
    console.log(
      "type:", r.combinationType,
      "| status:", r.status,
      "| confidence:", r.scoreJson?.confidence,
      "| evidenceScope:", r.evidenceScope,
    );
    for (const p of r.productsJson || []) {
      const notes = (p.notes || []).slice(0, 5).join(", ");
      console.log(`  - ${p.title} [${p.contribution}] — notes: ${notes || "(none)"}`);
    }
    console.log("shopifyProductId:", r.shopifyProductId || "(not created)");
    console.log("createdAt:", r.createdAt.toISOString());
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
