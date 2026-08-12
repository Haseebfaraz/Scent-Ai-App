// Persists the Odoo manufacturing-feasibility check as immutable historical evidence — one row per
// recommendation that was ACTUALLY walked by autoSelectAndConfirmBest, never for a candidate whose
// deterministic gate rejected it before Odoo was ever consulted. See the schema comment on
// RecommendationInventorySnapshot for why this is never updated after creation.
//
// Pure persistence — every value (maxBuildableBottles, limitingSku, each component's own
// maxBuildableBottlesForComponent) is computed exactly once by the caller
// (fragranceAgentTools.server.js's evaluateCandidateInventory, reusing fragranceFormula.server.js)
// and just written here verbatim, so the safe logs and this DB row can never drift apart.
import prisma from "../db.server.js";

/**
 * @param {object} args
 * @param {string} args.recommendationId
 * @param {boolean} args.inventoryValidated
 * @param {boolean} args.buildable
 * @param {string} args.checkedAt - ISO timestamp
 * @param {number} args.oilTotalMl
 * @param {number} args.alcoholMl
 * @param {string} args.requestStatus - "ok" | "lookup_failed"
 * @param {number|null} args.maxBuildableBottles
 * @param {string|null} args.limitingSku
 * @param {Array<{fragranceProductId: string|null, productTitle: string, odooSku: string|null,
 *   ratioPercent: number, requiredOilMl: number, onHandQty: number|null, mappingStatus: string,
 *   sufficient: boolean|null, maxBuildableBottlesForComponent: number|null}>} args.components
 */
export async function saveInventorySnapshot({
  recommendationId, inventoryValidated, buildable, checkedAt, oilTotalMl, alcoholMl,
  requestStatus, maxBuildableBottles, limitingSku, components,
}) {
  return prisma.recommendationInventorySnapshot.create({
    data: {
      recommendationId,
      inventoryValidated,
      buildable,
      checkedAt: new Date(checkedAt),
      oilTotalMl,
      alcoholMl,
      maxBuildableBottles,
      limitingSku,
      requestStatus,
      components: {
        create: components.map((c) => ({
          fragranceProductId: c.fragranceProductId,
          productTitle: c.productTitle,
          odooSku: c.odooSku,
          ratioPercent: c.ratioPercent,
          requiredOilMl: c.requiredOilMl,
          onHandQty: c.onHandQty,
          mappingStatus: c.mappingStatus,
          sufficient: c.sufficient,
          maxBuildableBottlesForComponent: c.maxBuildableBottlesForComponent,
        })),
      },
    },
    include: { components: true },
  });
}

export async function getInventorySnapshot(recommendationId) {
  return prisma.recommendationInventorySnapshot.findUnique({
    where: { recommendationId },
    include: { components: true },
  });
}
