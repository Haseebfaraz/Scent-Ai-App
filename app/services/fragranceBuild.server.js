// Fragrance preview page — Shopify product creation is DEFERRED until the customer explicitly
// clicks Save Build or Add to Cart on the preview page (never automatically when they confirm a
// recommendation in chat). This service owns that first-time creation, using the Top/Middle/Base
// Note three-option product shape app/routes/api.save-build.jsx already expects (that endpoint
// stays exactly as it was — it already knows how to re-price/resolve a variant for a NEW ratio on
// an EXISTING product; this service only ever handles the FIRST creation).
import prisma from "../db.server.js";
import { normalizeProductName } from "../utils/fragranceNormalization.js";
import { assignNotePositions } from "../utils/notePositionMapping.js";

const BOTTLE_ML = 34;
const FALLBACK_PRICE_PER_5ML = 20;
const POSITION_LABELS = { top: "Top Note", middle: "Middle Note", base: "Base Note" };
const BOTTLE_IMAGE_URL = "https://cdn.shopify.com/s/files/1/1005/4379/1236/files/animated_bottle.png?v=1784530062";

/**
 * Buckets every real note across every real component product into Top/Middle/Base, using the one
 * shared, deterministic utility — never duplicated in frontend code. `excludedNotes` (customer
 * edits from the preview page) are filtered out of the DISPLAY lists only; they never change the
 * real formula/pricing, which is always driven by the real component products.
 * @param {Array<{title: string, notes: string[]}>} internalProducts
 * @param {string[]} [excludedNotes]
 */
export function computeNotePositionBuckets(internalProducts, excludedNotes = []) {
  const excludedLower = new Set((excludedNotes || []).map((n) => String(n).toLowerCase()));
  const allNotes = (internalProducts || []).flatMap((p) => p.notes || []);
  const buckets = assignNotePositions(allNotes);
  return {
    top: buckets.top.filter((n) => !excludedLower.has(n.toLowerCase())),
    middle: buckets.middle.filter((n) => !excludedLower.has(n.toLowerCase())),
    base: buckets.base.filter((n) => !excludedLower.has(n.toLowerCase())),
  };
}

// A simple, deterministic default split weighted by how many real notes landed in each position —
// never a fixed 33/33/33 regardless of the real note distribution, but never invented either.
export function computeDefaultRatios(buckets) {
  const counts = { top: buckets.top.length || 1, middle: buckets.middle.length || 1, base: buckets.base.length || 1 };
  const total = counts.top + counts.middle + counts.base;
  const raw = { top: (counts.top / total) * 100, middle: (counts.middle / total) * 100, base: (counts.base / total) * 100 };
  const rounded = { top: Math.round(raw.top), middle: Math.round(raw.middle), base: Math.round(raw.base) };
  const diff = 100 - (rounded.top + rounded.middle + rounded.base);
  if (diff !== 0) {
    const largest = Object.entries(rounded).sort((a, b) => b[1] - a[1])[0][0];
    rounded[largest] += diff;
  }
  return rounded;
}

/**
 * First-time Shopify product creation for a confirmed recommendation, using the Top/Middle/Base
 * Note option shape api.save-build.jsx already expects. Never called if
 * recommendation.shopifyProductId is already set — ratio adjustments on an existing product go
 * through api.save-build.jsx directly (client-side), exactly as that endpoint was already designed
 * for; this function is not duplicated there.
 * @param {object} args
 * @param {object} args.admin - authenticated Shopify Admin API client.
 * @param {string} args.shopDomain
 * @param {object} args.recommendation - the FragranceRecommendation Prisma record.
 * @param {string} args.customName - customer-facing product name (draftName, or the deterministic fallback).
 * @param {{top: number, middle: number, base: number}} args.ratios - must sum to 100.
 * @param {string[]} [args.excludedNotes]
 * @param {string|null} args.customerName
 * @param {string|null} args.customerEmail
 * @returns {Promise<{productId: string, variantId: string, price: number, productUrl: string}>}
 */
export async function createShopifyBuildProduct({ admin, shopDomain, recommendation, customName, ratios, excludedNotes, customerName, customerEmail }) {
  const pctSum = ratios.top + ratios.middle + ratios.base;
  if (pctSum !== 100) {
    throw new Error(`Top/Middle/Base ratios must sum to 100 (got ${pctSum}).`);
  }

  const internalProducts = Array.isArray(recommendation.productsJson) ? recommendation.productsJson : [];
  const buckets = computeNotePositionBuckets(internalProducts, excludedNotes);

  // A single blended $/ml rate across every real component (weighted by each product's own
  // recommendedRatio share) — real component products no longer map 1:1 to a note position (a
  // single component's notes can land in more than one bucket), so a per-position rate can't be
  // attributed any more precisely than this without inventing a split the data doesn't support.
  const catalogRows = await prisma.fragranceProduct.findMany({
    where: { normalizedTitle: { in: internalProducts.map((p) => normalizeProductName(p.title)) } },
    select: { normalizedTitle: true, pricePer5ml: true },
  });
  const priceByNormalizedTitle = new Map(catalogRows.map((r) => [r.normalizedTitle, r.pricePer5ml]));
  const ratiosByProduct = Array.isArray(recommendation.ratiosJson) ? recommendation.ratiosJson : [];
  const avgPricePer5ml = ratiosByProduct.reduce((sum, r) => {
    const price = priceByNormalizedTitle.get(normalizeProductName(r.productTitle));
    return sum + (r.ratioPercent / 100) * (typeof price === "number" ? price : FALLBACK_PRICE_PER_5ML);
  }, 0) || FALLBACK_PRICE_PER_5ML;

  const layers = ["top", "middle", "base"].map((position) => {
    const quantityMl = Math.round(((ratios[position] / 100) * BOTTLE_ML) * 10) / 10;
    return { position, notes: buckets[position], quantityMl, pricePer5ml: avgPricePer5ml };
  });

  const totalPrice = layers.reduce((sum, l) => sum + (l.pricePer5ml / 5) * l.quantityMl, 0);
  const priceString = totalPrice.toFixed(2);

  const productOptions = layers.map((l) => ({
    name: POSITION_LABELS[l.position],
    // Real notes only, comma-joined, ratio-suffixed to match api.save-build.jsx's
    // stripRatioSuffix/withRatioSuffix/extractRatioPercent convention exactly. Product NAMES never
    // appear here — only real note text.
    values: [{ name: `${l.notes.join(", ")} (${Math.round(ratios[l.position])}%)` }],
  }));

  const notesSummaryHtml = layers
    .map((l) => `<strong>${POSITION_LABELS[l.position]}</strong> (${Math.round(ratios[l.position])}%): ${l.notes.join(", ")}`)
    .join("<br>");
  const fullDescription =
    `<p>${notesSummaryHtml}</p>` +
    `<p><strong>Type:</strong> ${recommendation.combinationType}</p>` +
    `<p><strong>Longevity:</strong> A rich, parfum-concentration blend crafted for long-lasting wear.</p>`;

  const createResponse = await admin.graphql(`
    mutation createProduct($input: ProductInput!) {
      productCreate(input: $input) {
        product { id handle }
        userErrors { field message }
      }
    }
  `, {
    variables: {
      input: {
        title: customName,
        descriptionHtml: fullDescription,
        vendor: "The Dua Brand",
        status: "ACTIVE",
        templateSuffix: "custom-scent",
        productOptions,
        metafields: [
          {
            namespace: "custom",
            key: "note_composition",
            type: "json",
            value: JSON.stringify({ recommendationId: recommendation.id, combinationType: recommendation.combinationType, layers }),
          },
          // Admin-only by default — real component product names/IDs are preserved here for
          // formula/evidence purposes (Shopify creation, pricing, recommendation evidence), never
          // exposed on the storefront-visible option values above.
          {
            namespace: "custom",
            key: "internal_components",
            type: "json",
            value: JSON.stringify(internalProducts.map((p) => ({ title: p.title, contribution: p.contribution }))),
          },
          { namespace: "custom", key: "customer_name", type: "single_line_text_field", value: customerName || "" },
          { namespace: "custom", key: "customer_email", type: "single_line_text_field", value: customerEmail || "" },
        ],
      },
    },
  });
  const createJson = await createResponse.json();
  const product = createJson.data?.productCreate?.product;
  const createErrors = createJson.data?.productCreate?.userErrors;
  if (!product || (createErrors && createErrors.length > 0)) {
    throw new Error(createErrors?.map((e) => e.message).join(", ") || "Product creation failed.");
  }

  try {
    await admin.graphql(`
      mutation attachBottleImage($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) { mediaUserErrors { field message } }
      }
    `, { variables: { productId: product.id, media: [{ mediaContentType: "IMAGE", originalSource: BOTTLE_IMAGE_URL, alt: customName }] } });
  } catch (err) {
    console.error("Failed to attach bottle image:", err.message || err);
  }

  try {
    const publicationsResponse = await admin.graphql(`query getPublications { publications(first: 25) { nodes { id } } }`);
    const publicationsJson = await publicationsResponse.json();
    const publicationIds = publicationsJson.data?.publications?.nodes?.map((n) => n.id) || [];
    if (publicationIds.length > 0) {
      await admin.graphql(`
        mutation publishToAllChannels($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) { userErrors { field message } }
        }
      `, { variables: { id: product.id, input: publicationIds.map((pubId) => ({ publicationId: pubId })) } });
    }
  } catch (err) {
    console.error("Failed to publish product to sales channels:", err.message || err);
  }

  const variantsResponse = await admin.graphql(`
    query getVariants($id: ID!) { product(id: $id) { variants(first: 1) { edges { node { id } } } } }
  `, { variables: { id: product.id } });
  const variantsJson = await variantsResponse.json();
  const defaultVariantId = variantsJson.data?.product?.variants?.edges?.[0]?.node?.id;

  if (defaultVariantId) {
    await admin.graphql(`
      mutation setPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          product { id }
          userErrors { field message }
        }
      }
    `, { variables: { productId: product.id, variants: [{ id: defaultVariantId, price: priceString, inventoryItem: { tracked: false } }] } });
  }

  const cleanShopDomain = shopDomain.replace(/^https?:\/\//, "");
  const productUrl = `https://${cleanShopDomain}/products/${product.handle}`;

  return { productId: product.id, variantId: defaultVariantId, price: parseFloat(priceString), productUrl };
}

export async function markRecommendationDraft(recommendationId, { name, excludedNotes, ratios }) {
  return prisma.fragranceRecommendation.update({
    where: { id: recommendationId },
    data: {
      buildStatus: "draft",
      draftName: name ?? undefined,
      draftExcludedNotes: excludedNotes ?? undefined,
      draftRatiosJson: ratios ?? undefined,
    },
  });
}

export async function markRecommendationSaved(recommendationId, { shopifyProductId, shopifyVariantId }) {
  return prisma.fragranceRecommendation.update({
    where: { id: recommendationId },
    data: { buildStatus: "saved", shopifyProductId, shopifyVariantId },
  });
}
