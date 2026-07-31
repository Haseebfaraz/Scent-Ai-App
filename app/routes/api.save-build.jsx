// Called from the custom-scent-product theme section when the customer clicks "Save Build" —
// recomputes the product's price from the slider ratios they landed on and gives that exact
// ratio its own product variant (creating one if it doesn't exist yet, reusing it if it does),
// so the price they see is the price actually charged at checkout.
//
// Deliberately does NOT mutate a single shared variant's price in place: Shopify carts always
// display a variant's *current* price (not the price at add-to-cart time), so if two different
// saved ratios both pointed at the same variant, saving a new ratio would silently change the
// price of an item already sitting in someone else's cart. Every distinct ratio gets its own
// variant instead, so its price is locked in for good once created.
import { unauthenticated } from "../shopify.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, ngrok-skip-browser-warning",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// Fix (Save Build/Add to Cart CORS failure) — confirmed via a live curl test against this same
// server (see chat.jsx's CHAT_CORS_HEADERS comment) that React Router routes a browser's CORS
// preflight OPTIONS request to a route's loader, not its action, even though action() below also
// has its own (dead-in-production) OPTIONS branch. This route only ever exported an action, so the
// preflight hit nothing with CORS headers at all and the browser blocked the real POST before it
// was ever sent — exactly the "Failed to fetch" / "No Access-Control-Allow-Origin header" error
// seen live from the custom-scent-product theme section.
export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return new Response(null, { status: 405, headers: corsHeaders });
}

// Shopify caps every product at 3 options total, so a separate 4th option to track the ratio
// (e.g. "5-90-5") isn't possible once a product already uses Top/Middle/Base Note for its note
// descriptions — attempting it fails with "Can only specify a maximum of 3 options". Instead,
// the ratio is encoded as a "(NN%)" suffix on each position's own option value. MUST stay in
// sync with the identical helpers in app/routes/chat.jsx's createDynamicProduct.
const RATIO_SUFFIX_PATTERN = / \(\d+%\)$/;
function stripRatioSuffix(value) {
  return value.replace(RATIO_SUFFIX_PATTERN, "");
}
function withRatioSuffix(baseValue, pct) {
  return `${stripRatioSuffix(baseValue)} (${Math.round(pct)}%)`;
}

const OPTION_NAME_TO_POSITION = { "Top Note": "top", "Middle Note": "middle", "Base Note": "base" };

// Two ratios this close together are treated as "the same build" — imprecise dragging easily
// lands a pixel or two off a previous attempt (46% vs 48%), and without this every tiny wobble
// would mint its own near-duplicate variant instead of just reusing the one already close enough.
const MATCH_TOLERANCE_PCT = 3;

function extractRatioPercent(optionValue) {
  const match = optionValue.match(/\((\d+)%\)$/);
  return match ? parseInt(match[1], 10) : null;
}

// Custom fragrances are made to order — there's no real stock count to track, and every product's
// original/default variant is already untracked (Shopify's own default), which is exactly why it's
// always been purchasable despite showing "0 available" in admin. Trying to give build-variants a
// real tracked quantity instead (via inventorySetQuantities/inventoryActivate + a location) turned
// tracking ON without ever reliably getting them stocked anywhere, making them show as sold out —
// worse than doing nothing. So new variants are created untracked directly, and any variant reused
// via the tolerance match below gets forced back to untracked too, in case an earlier, broken
// version of this endpoint left it tracked-but-not-actually-stocked.
async function ensureVariantUntracked(admin, inventoryItemId) {
  if (!inventoryItemId) return;
  try {
    const response = await admin.graphql(`
      mutation untrackInventoryItem($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
          userErrors { message }
        }
      }
    `, { variables: { id: inventoryItemId, input: { tracked: false } } });
    const json = await response.json();
    const errors = json.data?.inventoryItemUpdate?.userErrors;
    if (errors && errors.length > 0) {
      console.error("inventoryItemUpdate userErrors:", JSON.stringify(errors));
    }
  } catch (err) {
    console.error("Failed to mark variant as untracked:", err);
  }
}

// Fix (editable product name on the live product page) — the theme's title field now sends
// whatever the customer typed alongside the ratio; best-effort the same way ensureVariantUntracked
// above is — a rename failure shouldn't fail the price/variant save, which is what actually matters
// for checkout.
async function renameProductIfProvided(admin, productId, name) {
  if (typeof name !== "string" || !name.trim()) return;
  try {
    const response = await admin.graphql(`
      mutation renameBuildProduct($input: ProductInput!) {
        productUpdate(input: $input) { userErrors { field message } }
      }
    `, { variables: { input: { id: productId, title: name.trim() } } });
    const json = await response.json();
    const errors = json.data?.productUpdate?.userErrors;
    if (errors && errors.length > 0) {
      console.error("productUpdate (rename) userErrors:", JSON.stringify(errors));
    }
  } catch (err) {
    console.error("Failed to rename product:", err);
  }
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const originHeader = request.headers.get("Origin") || "";
    const shopDomain = originHeader.replace(/^https?:\/\//, "").split("/")[0] || "test-3d-products.myshopify.com";

    const { admin } = await unauthenticated.admin(shopDomain);

    const { productId, ratios, name } = await request.json();
    if (!productId || !ratios) {
      return new Response(JSON.stringify({ error: "productId and ratios are required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    await renameProductIfProvided(admin, productId, name);

    const productResponse = await admin.graphql(`
      query getProductForPricing($id: ID!) {
        product(id: $id) {
          metafield(namespace: "custom", key: "note_composition") { value }
          variants(first: 100) {
            edges { node { id price selectedOptions { name value } inventoryItem { id tracked } } }
          }
        }
      }
    `, { variables: { id: productId } });
    const productJson = await productResponse.json();
    const product = productJson.data?.product;
    const metafieldValue = product?.metafield?.value;

    if (!product || !metafieldValue || product.variants.edges.length === 0) {
      return new Response(JSON.stringify({ error: "Could not find product or its note composition." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const { layers } = JSON.parse(metafieldValue);

    // Same grouping as the theme section: blended $/ml rate per position, from whatever
    // containers/quantities were actually confirmed at creation time.
    const byPosition = {};
    let totalMl = 0;
    for (const layer of layers) {
      const ml = layer.quantityMl || 0;
      const cost = (ml / 5) * (layer.pricePer5ml || 0);
      totalMl += ml;
      const bucket = byPosition[layer.position] || { ml: 0, cost: 0 };
      bucket.ml += ml;
      bucket.cost += cost;
      byPosition[layer.position] = bucket;
    }

    const newPrice = Object.entries(ratios).reduce((sum, [position, pct]) => {
      const bucket = byPosition[position];
      if (!bucket || bucket.ml === 0) return sum;
      const rate = bucket.cost / bucket.ml;
      const newMl = (pct / 100) * totalMl;
      return sum + rate * newMl;
    }, 0);

    if (!(newPrice > 0)) {
      return new Response(JSON.stringify({ error: "Computed price was invalid." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const priceString = newPrice.toFixed(2);

    // The original/default variant's values have no "(NN%)" suffix at all — its real ratio is
    // whatever it was actually created with, derived from the same ml shares used for pricing.
    const originalPercents = {};
    for (const [position, bucket] of Object.entries(byPosition)) {
      originalPercents[position] = (bucket.ml / totalMl) * 100;
    }

    // Find the closest existing variant to the requested ratio (by the largest single-position
    // difference), and reuse it outright if it's within tolerance — no new variant, no price
    // recompute, just hand back what's already there. Only genuinely different ratios get a new
    // variant, so a customer nudging the slider back and forth doesn't fragment into dozens of
    // near-identical, barely-different-priced variants.
    let closestEdge = null;
    let closestDistance = Infinity;
    for (const edge of product.variants.edges) {
      let distance = 0;
      for (const opt of edge.node.selectedOptions) {
        const position = OPTION_NAME_TO_POSITION[opt.name];
        if (!position || ratios[position] === undefined) continue;
        const variantPct = extractRatioPercent(opt.value) ?? originalPercents[position] ?? 0;
        distance = Math.max(distance, Math.abs(variantPct - ratios[position]));
      }
      if (distance < closestDistance) {
        closestDistance = distance;
        closestEdge = edge;
      }
    }

    if (closestEdge && closestDistance <= MATCH_TOLERANCE_PCT) {
      if (closestEdge.node.inventoryItem?.tracked) {
        await ensureVariantUntracked(admin, closestEdge.node.inventoryItem.id);
      }
      return new Response(JSON.stringify({ price: closestEdge.node.price, variantId: closestEdge.node.id, created: false }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Every option on this product IS a position option (Top/Middle/Base Note) — build the exact
    // target option-value combination for the requested ratio by re-suffixing each one's current
    // base value (with any existing "(NN%)" stripped first) with the new percentage.
    const referenceVariant = product.variants.edges[0].node;
    const targetOptionValues = referenceVariant.selectedOptions.map(opt => {
      const position = OPTION_NAME_TO_POSITION[opt.name];
      const pct = position ? ratios[position] : undefined;
      return {
        optionName: opt.name,
        name: pct !== undefined ? withRatioSuffix(opt.value, pct) : opt.value
      };
    });

    const variantCreateResponse = await admin.graphql(`
      mutation createBuildVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          userErrors { field message }
          productVariants { id price }
        }
      }
    `, {
      variables: {
        productId,
        variants: [{
          price: priceString,
          optionValues: targetOptionValues,
          inventoryItem: { tracked: false }
        }]
      }
    });
    const variantCreateJson = await variantCreateResponse.json();
    const variantErrors = variantCreateJson.data?.productVariantsBulkCreate?.userErrors;

    if (variantErrors && variantErrors.length > 0) {
      return new Response(JSON.stringify({ error: variantErrors.map(e => e.message).join(", ") }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const newVariant = variantCreateJson.data.productVariantsBulkCreate.productVariants[0];

    // Lets the client know this is a brand-new variant (as opposed to one reused via the
    // tolerance match above) — Shopify takes a few seconds to propagate a freshly created
    // variant's availability to the storefront/cart, so the client waits briefly before letting
    // the customer add it to cart. Reused variants have already had time to propagate.
    return new Response(JSON.stringify({ price: newVariant.price, variantId: newVariant.id, created: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("save-build error:", err);
    return new Response(JSON.stringify({ error: "Failed to save build." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}
