// Shared, side-effect-free pricing math for a fixed 34ml custom-scent bottle. Deliberately kept
// out of fragranceBuild.server.js (a `.server.js` file — DB access, Shopify Admin API calls, never
// importable from client-rendered code) so the preview page's component can reuse the exact same
// formula for a LIVE price recompute as the customer drags a slider, not just the loader's one-time
// server-computed estimate.
export const BOTTLE_ML = 34;

// Total price for the 34ml bottle at a given Top/Middle/Base ratio, given each position's own real
// $/5ml rate (see fragranceBuild.server.js's computePricePer5mlByPosition).
export function estimateTotalPrice(pricePer5mlByPosition, ratios) {
  return ["top", "middle", "base"].reduce((sum, position) => {
    const ml = ((ratios[position] || 0) / 100) * BOTTLE_ML;
    return sum + (pricePer5mlByPosition[position] / 5) * ml;
  }, 0);
}
