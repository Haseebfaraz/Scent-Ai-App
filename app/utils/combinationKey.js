import { normalizeProductName } from "./fragranceNormalization.js";

// Order-independent identity key for a set of component products — "A + B" and "B + A" must
// resolve to the exact same key, so ExistingCombination.componentKey can be a real unique
// constraint and generate_new_product_combinations can reliably check "does this already exist."
export function createCombinationKey(productTitles) {
  return productTitles
    .map(normalizeProductName)
    .filter(Boolean)
    .sort()
    .join("||");
}
