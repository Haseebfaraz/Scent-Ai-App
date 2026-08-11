// Odoo oil-inventory manufacturing formula — separate from, and never touching, the existing
// Top/Middle/Base display math (fragranceBuild.server.js) or PricePer5ml pricing (fragrancePricing.js).
// Supersedes the earlier premixed-gallon model: Odoo inventory tracks fragrance OIL/CONCENTRATE, not
// a finished premixed gallon. A 34ml bottle is oilTotalMl (12-14ml, default 13ml) of real fragrance
// oil plus alcohol as the remainder. The recommendation's ratioPercent applies ONLY to the oil
// portion — never to the full 34ml.
export const FINISHED_BOTTLE_ML = 34;
export const DEFAULT_OIL_ML = 13;
export const MIN_OIL_ML = 12;
export const MAX_OIL_ML = 14;

const RATIO_SUM_TOLERANCE = 0.5; // percentage points

export function computeAlcoholMl(oilTotalMl = DEFAULT_OIL_ML) {
  return FINISHED_BOTTLE_ML - oilTotalMl;
}

// One component's real oil requirement for a single bottle, given its ratioPercent (0-100).
// Rounded to 0.01ml — finer than that is floating-point noise (13 * 0.65 === 8.450000000000001 in
// JS), not real manufacturing precision; nothing about this bottle is measured to the micro-liter.
export function computeRequiredOilMl(oilTotalMl, ratioPercent) {
  return Math.round(oilTotalMl * (ratioPercent / 100) * 100) / 100;
}

/**
 * Builds the full oil-based production formula for a combination's real ratios — the single source
 * of truth for both the feasibility check and the recommendation-inventory snapshot.
 * @param {Array<{productTitle: string, ratioPercent: number, fragranceProductId?: string}>} ratios
 * @param {number} [oilTotalMl]
 */
export function buildProductionFormula(ratios, oilTotalMl = DEFAULT_OIL_ML) {
  if (oilTotalMl < MIN_OIL_ML || oilTotalMl > MAX_OIL_ML || Number.isNaN(oilTotalMl)) {
    throw new Error(`oilTotalMl must be between ${MIN_OIL_ML} and ${MAX_OIL_ML} (got ${oilTotalMl}).`);
  }
  if (!Array.isArray(ratios) || ratios.length === 0) {
    throw new Error("A production formula requires at least one ratio component.");
  }

  const pctSum = ratios.reduce((sum, r) => sum + (r.ratioPercent || 0), 0);
  if (ratios.some((r) => !(r.ratioPercent >= 0) || Number.isNaN(r.ratioPercent))) {
    throw new Error("Ratio percentages must be non-negative numbers.");
  }
  if (Math.abs(pctSum - 100) > RATIO_SUM_TOLERANCE) {
    throw new Error(`Ratio percentages must total 100% within tolerance (got ${pctSum}%).`);
  }

  const alcoholMl = computeAlcoholMl(oilTotalMl);
  const components = ratios.map((r) => ({
    fragranceProductId: r.fragranceProductId ?? null,
    productTitle: r.productTitle,
    ratioPercent: r.ratioPercent,
    requiredOilMl: computeRequiredOilMl(oilTotalMl, r.ratioPercent),
  }));

  const oilSum = components.reduce((sum, c) => sum + c.requiredOilMl, 0);
  if (Math.abs(oilSum - oilTotalMl) > RATIO_SUM_TOLERANCE * (oilTotalMl / 100)) {
    throw new Error(`Component oil quantities must total oilTotalMl (got ${oilSum} vs ${oilTotalMl}).`);
  }
  if (Math.abs(oilTotalMl + alcoholMl - FINISHED_BOTTLE_ML) > 0.001) {
    throw new Error(`oilTotalMl + alcoholMl must equal ${FINISHED_BOTTLE_ML}ml.`);
  }

  return { bottleSizeMl: FINISHED_BOTTLE_ML, oilTotalMl, alcoholMl, components };
}

// How many whole bottles this single component's available oil could supply.
export function computeComponentCapacity(availableOilMl, requiredOilMlPerBottle) {
  if (!(requiredOilMlPerBottle > 0) || !(availableOilMl >= 0)) return 0;
  return Math.floor(availableOilMl / requiredOilMlPerBottle);
}

/**
 * A combination is buildable only if every component has enough available oil for at least one
 * bottle; the true maximum is the smallest per-component capacity (the limiting oil).
 * @param {Array<{productTitle: string, requiredOilMl: number, availableOilMl: number|null}>} components
 */
export function computeFeasibility(components) {
  const perComponent = components.map((c) => ({
    productTitle: c.productTitle,
    requiredOilMl: c.requiredOilMl,
    availableOilMl: c.availableOilMl,
    capacity: c.availableOilMl == null ? 0 : computeComponentCapacity(c.availableOilMl, c.requiredOilMl),
    buildableForComponent: c.availableOilMl != null && c.availableOilMl >= c.requiredOilMl,
  }));

  const buildable = perComponent.every((c) => c.buildableForComponent);
  const maximumBuildableBottles = buildable ? Math.min(...perComponent.map((c) => c.capacity)) : 0;
  const limiting = perComponent.reduce((worst, c) => (worst === null || c.capacity < worst.capacity ? c : worst), null);

  return {
    buildable,
    maximumBuildableBottles,
    limitingProductTitle: limiting?.productTitle ?? null,
    components: perComponent,
  };
}
