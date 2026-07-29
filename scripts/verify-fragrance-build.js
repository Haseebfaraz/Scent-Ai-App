#!/usr/bin/env node
// Read-only verification for the fragrance preview page's Save Build / Add to Cart flows —
// cross-checks a FragranceRecommendation's DB state against the REAL Shopify product it created
// (options, variants, metafields), straight from the Admin GraphQL API.
//
// STRICTLY READ-ONLY: the only Shopify Admin API call this script makes is a single GraphQL
// `query` (see verifyBuildProduct below) — no `mutation` of any kind appears anywhere in this
// file, so it cannot create, update, or delete a product, variant, or metafield. The only Prisma
// calls are `findUnique` reads. Safe to run against a live store any number of times.
//
// No secrets, tokens, shop domains, recommendation IDs, product IDs, or customer data are
// hardcoded anywhere below — every one of those is a required argument or comes from the
// environment (see "Required environment variables" further down). Running this script with no
// arguments does nothing but print a usage error.
//
// Usage — recommendation mode (looks up recommendation.shopifyProductId, cross-checks DB state):
//   node scripts/verify-fragrance-build.js --shop=<shop-domain> --recommendation=<recommendation-id>
//
// Usage — product mode (checks the Shopify product directly, no DB cross-check):
//   node scripts/verify-fragrance-build.js --shop=<shop-domain> --product="gid://shopify/Product/<product-id>"
//
// Required environment variables (same ones app/routes/api.save-build.jsx already needs):
//   SHOPIFY_API_KEY     - this repo's Shopify app API key
//   SHOPIFY_API_SECRET  - this repo's Shopify app API secret (NOT present in the local .env by
//                          design; only Render's environment has the real value — run this script
//                          wherever that real secret is available, e.g. via Render's shell)
//   DATABASE_URL        - only needed in --recommendation mode, to read the FragranceRecommendation row
// The target shop must also already have a stored offline access token in the Session table
// (i.e. this app must already be installed on it) — unauthenticated.admin() reads that token, it
// does not perform a fresh OAuth flow.
//
// Expected output on a healthy Save Build (--recommendation mode) — what to look for in each
// section the script prints:
//   Product title       - "title:" under "--- Shopify product ---" equals the fragrance name the
//                          customer set on the preview page (also printed as "draftName:" below,
//                          for direct comparison — a PASS/FAIL line calls this out explicitly).
//   Top/Middle/Base Note
//     options            - "options:" is a JSON array of exactly 3 entries named "Top Note",
//                          "Middle Note", "Base Note" (order may vary) — a PASS/FAIL line checks
//                          all 3 names are present.
//   Variant IDs          - one "variant <gid> — price ... — tracked=false" line per real variant
//                          on the product; tracked must be false for every one (a untracked
//                          custom-build variant is the expected, working state — see the comment
//                          in app/routes/api.save-build.jsx on why).
//   Selected variant     - "recommendation.shopifyVariantId is one of the product's real
//                          variants" PASS/FAIL line confirms the DB's stored variant ID actually
//                          matches one of the variants Shopify returns for this product.
//   note_composition
//     metafield           - printed as parsed JSON: {recommendationId, combinationType,
//                          layers: [{position, notes, quantityMl, pricePer5ml}, ...]} — exactly 3
//                          layers (top/middle/base), never product names inside `notes`.
//   internal_components
//     metafield           - printed as raw JSON: [{title, contribution}, ...] — the REAL component
//                          product names, present here only (never in note_composition/options).
//   Build status         - "buildStatus:" under the DB cross-check section must read "saved"
//                          (not "draft") once Save Build has actually run.
//   Draft name            - "draftName:" is the customer's edited name; a PASS/FAIL line confirms
//                          it equals the Shopify product's real title.
//   Draft ratios          - "draftRatiosJson:" e.g. {"top":40,"middle":35,"base":25}; a PASS/FAIL
//                          line per position confirms that percentage matches the "(NN%)" suffix
//                          actually baked into that position's Shopify option value.
//   Database-to-Shopify
//     match result         - the final "N/N checks passed." line is the single pass/fail verdict;
//                          exit code is 0 only when every one of those N checks passed.

import prisma from "../app/db.server.js";
import { unauthenticated } from "../app/shopify.server.js";

function parseArgs(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function check(label, passed, detail) {
  console.log(`${passed ? "PASS" : "FAIL"} — ${label}${detail ? `: ${detail}` : ""}`);
  return passed;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.shop) {
    throw new Error("--shop=<shop-domain> is required (e.g. --shop=your-store.myshopify.com). No default is hardcoded.");
  }
  const shopDomain = args.shop;

  let recommendation = null;
  if (args.recommendation) {
    recommendation = await prisma.fragranceRecommendation.findUnique({ where: { id: args.recommendation } });
    if (!recommendation) throw new Error(`No FragranceRecommendation with id ${args.recommendation}`);
  }
  const productId = args.product || recommendation?.shopifyProductId;
  if (!productId) throw new Error("Pass --recommendation=<id> (with a saved product) or --product=<gid>.");

  const { admin } = await unauthenticated.admin(shopDomain);

  const response = await admin.graphql(`
    query verifyBuildProduct($id: ID!) {
      product(id: $id) {
        id
        title
        vendor
        options { name values }
        variants(first: 100) {
          edges { node { id price selectedOptions { name value } inventoryItem { tracked } } }
        }
        noteComposition: metafield(namespace: "custom", key: "note_composition") { value }
        internalComponents: metafield(namespace: "custom", key: "internal_components") { value }
        customerName: metafield(namespace: "custom", key: "customer_name") { value }
      }
    }
  `, { variables: { id: productId } });
  const json = await response.json();
  const product = json.data?.product;

  if (!product) {
    console.log(`FAIL — product ${productId} not found on ${shopDomain} (or session invalid — check Session table).`);
    process.exitCode = 1;
    return;
  }

  console.log("--- Shopify product ---");
  console.log("id:", product.id);
  console.log("title:", product.title);
  console.log("vendor:", product.vendor);
  console.log("options:", JSON.stringify(product.options));
  console.log("variant count:", product.variants.edges.length);
  for (const edge of product.variants.edges) {
    console.log(`  variant ${edge.node.id} — price ${edge.node.price} — tracked=${edge.node.inventoryItem?.tracked}`);
    console.log(`    options: ${edge.node.selectedOptions.map((o) => `${o.name}=${o.value}`).join(" | ")}`);
  }

  let composition = null;
  try {
    composition = JSON.parse(product.noteComposition?.value || "null");
  } catch { /* leave null */ }
  console.log("note_composition metafield:", JSON.stringify(composition));
  console.log("internal_components metafield:", product.internalComponents?.value || "(none)");

  console.log("\n--- Checks ---");
  const results = [];
  results.push(check("exactly one product (this query)", true, product.id));
  results.push(check(
    "product has 3 options named Top/Middle/Base Note",
    ["Top Note", "Middle Note", "Base Note"].every((n) => product.options.some((o) => o.name === n)),
    product.options.map((o) => o.name).join(", "),
  ));
  results.push(check("note_composition metafield present and parses", !!composition));
  if (composition) {
    results.push(check(
      "note_composition has exactly 3 layers (top/middle/base)",
      Array.isArray(composition.layers) && composition.layers.length === 3,
    ));
  }
  results.push(check("internal_components metafield present (real product names preserved)", !!product.internalComponents?.value));
  results.push(check("no variant left inventory-tracked (would show sold out)", product.variants.edges.every((e) => !e.node.inventoryItem?.tracked)));

  if (recommendation) {
    console.log("\n--- DB cross-check (FragranceRecommendation) ---");
    console.log("buildStatus:", recommendation.buildStatus);
    console.log("draftName:", recommendation.draftName);
    console.log("draftExcludedNotes:", JSON.stringify(recommendation.draftExcludedNotes));
    console.log("draftRatiosJson:", JSON.stringify(recommendation.draftRatiosJson));
    console.log("shopifyProductId:", recommendation.shopifyProductId);
    console.log("shopifyVariantId:", recommendation.shopifyVariantId);
    results.push(check("recommendation.buildStatus === 'saved'", recommendation.buildStatus === "saved"));
    results.push(check("recommendation.draftName matches product title", recommendation.draftName === product.title, `"${recommendation.draftName}" vs "${product.title}"`));
    results.push(check(
      "recommendation.shopifyVariantId is one of the product's real variants",
      product.variants.edges.some((e) => e.node.id === recommendation.shopifyVariantId),
    ));
    if (recommendation.draftRatiosJson && composition) {
      for (const layer of composition.layers) {
        const expectedPct = recommendation.draftRatiosJson[layer.position];
        const opt = product.options.find((o) => o.name.toLowerCase().startsWith(layer.position));
        const value = opt?.values?.[0] || "";
        const actualPct = value.match(/\((\d+)%\)/)?.[1];
        results.push(check(
          `${layer.position} option's (NN%) suffix matches draftRatiosJson.${layer.position}`,
          String(Math.round(expectedPct)) === actualPct,
          `expected ${expectedPct}, option value "${value}"`,
        ));
      }
    }
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
