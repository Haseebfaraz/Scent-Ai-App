// Merchant-facing detail view for one customer — full saved profile plus every combination ever
// generated for them, with the real ratio and the stored "why this suits them" explanation. Linked
// from app._index.jsx's customer table. Read-only, same as that page — nothing here writes data.
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { emptyProfile } from "../services/customerProfile.server";

export async function loader({ request, params }) {
  await authenticate.admin(request);
  const { conversationId } = params;

  const profileRow = await prisma.customerProfileState.findUnique({ where: { conversationId } });
  if (!profileRow) {
    throw new Response("Customer not found", { status: 404 });
  }
  const profile = { ...emptyProfile(), ...profileRow.profileJson };

  // Fix (inventory observability) — the persisted snapshot + component rows, joined in this same
  // query so opening this page never triggers a fresh Odoo call just to show historical evidence
  // (point 12 of the spec) — the admin UI only ever reads what was already recorded at
  // selection/rejection time.
  const recommendations = await prisma.fragranceRecommendation.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    include: { inventorySnapshot: { include: { components: true } } },
  });

  return {
    conversationId,
    profile,
    updatedAt: profileRow.updatedAt,
    recommendations: recommendations.map((r) => ({
      id: r.id,
      status: r.status,
      combinationType: r.combinationType,
      createdAt: r.createdAt,
      confirmedAt: r.confirmedAt,
      shopifyProductId: r.shopifyProductId,
      name: r.customerFacingJson?.customerFacingName || "(unnamed)",
      whySuits: r.customerFacingJson?.customerFacingWhySuits || null,
      bestUse: r.customerFacingJson?.customerFacingBestUse || null,
      confidence: r.scoreJson?.confidence || null,
      confidenceBreakdown: r.scoreJson?.confidenceBreakdown || null,
      // Fix (confidence explanation popup) — already computed and persisted by
      // recommendationEngine.server.js/recommendationConfirmation.server.js; just wasn't being
      // surfaced anywhere in the admin UI until now.
      riskBreakdown: Array.isArray(r.scoreJson?.riskBreakdown) ? r.scoreJson.riskBreakdown : [],
      riskPenalty: r.scoreJson?.riskPenalty ?? null,
      matchedExactNotes: Array.isArray(r.scoreJson?.matchedExactNotes) ? r.scoreJson.matchedExactNotes : [],
      missingExactNotes: Array.isArray(r.scoreJson?.missingExactNotes) ? r.scoreJson.missingExactNotes : [],
      exactNoteCoverageScore: r.scoreJson?.exactNoteCoverageScore ?? null,
      ratios: Array.isArray(r.ratiosJson) ? r.ratiosJson : [],
      components: Array.isArray(r.productsJson) ? r.productsJson : [],
      // null when this candidate never reached Odoo at all (rejected by the deterministic gate
      // first) — the admin card renders no inventory section at all in that case, rather than
      // fabricating a state for a check that never happened.
      inventory: r.inventorySnapshot
        ? {
            inventoryValidated: r.inventorySnapshot.inventoryValidated,
            buildable: r.inventorySnapshot.buildable,
            checkedAt: r.inventorySnapshot.checkedAt,
            oilTotalMl: r.inventorySnapshot.oilTotalMl,
            alcoholMl: r.inventorySnapshot.alcoholMl,
            maxBuildableBottles: r.inventorySnapshot.maxBuildableBottles,
            limitingSku: r.inventorySnapshot.limitingSku,
            requestStatus: r.inventorySnapshot.requestStatus,
            components: r.inventorySnapshot.components.map((c) => ({
              productTitle: c.productTitle,
              odooSku: c.odooSku,
              ratioPercent: c.ratioPercent,
              requiredOilMl: c.requiredOilMl,
              onHandQty: c.onHandQty,
              mappingStatus: c.mappingStatus,
              sufficient: c.sufficient,
              maxBuildableBottlesForComponent: c.maxBuildableBottlesForComponent,
            })),
          }
        : null,
    })),
  };
}

const STATUS_TONE = { confirmed: "success", pending: "warning", expired: "critical" };
const CONFIDENCE_DIMENSION_LABELS = {
  data: "Note data quality",
  historical: "Real order-history evidence",
  compatibility: "Note compatibility / risk",
  novelty: "Similarity to existing combinations",
  customerFit: "Fit to this customer's stated preferences",
};
const LEVEL_TONE = { low: "critical", medium: "warning", high: "success" };
const LEVEL_BAR = { low: { width: "33%", background: "#d82c0d" }, medium: { width: "66%", background: "#b98900" }, high: { width: "100%", background: "#008060" } };

function formatRatios(ratios) {
  return ratios.length
    ? ratios.map((r) => `${r.productTitle} ${Math.round(r.ratioPercent)}%`).join(" / ")
    : "—";
}

function formatComponents(components) {
  return components.length
    ? components
        .map((p) => `${p.title}${p.contribution ? ` (${p.contribution})` : ""} — ${(p.notes || []).join(", ")}`)
        .join("; ")
    : "—";
}

// Three distinct states, never collapsed into one another (point 7 of the spec) — a WARN-mode
// lookup failure/unresolved component must never read as a green BUILDABLE badge just because the
// recommendation flow itself was allowed to continue.
function inventoryStatusBadge(inventory) {
  if (!inventory.inventoryValidated) return { tone: "warning", label: "⚠ NOT VALIDATED" };
  return inventory.buildable ? { tone: "success", label: "✅ BUILDABLE" } : { tone: "critical", label: "❌ NOT BUILDABLE" };
}

// Odoo returns no UoM field; onHandQty is already normalized to ml upstream in
// odooInventory.server.js (unit: "ml" assumption documented there) — this is the one place the
// admin UI attaches the "ml" label, so changing the assumption never means hunting through JSX.
const ML = (n) => (typeof n === "number" ? `${n.toFixed(2)} ml` : "—");
const TH_STYLE = { textAlign: "left", padding: "4px 8px", borderBottom: "1px solid #c9cccf", fontWeight: 600 };
const TD_STYLE = { padding: "4px 8px", borderBottom: "1px solid #e1e3e5" };

function InventorySection({ inventory }) {
  if (!inventory) return null;
  const badge = inventoryStatusBadge(inventory);
  const insufficientComponents = inventory.components.filter((c) => c.sufficient === false);
  const limitingComponent = inventory.components.find((c) => c.odooSku === inventory.limitingSku);

  return (
    <s-stack direction="block" gap="tight">
      <s-stack direction="inline" gap="tight" alignItems="center">
        <s-text type="strong">Inventory</s-text>
        <s-badge tone={badge.tone}>{badge.label}</s-badge>
        {inventory.inventoryValidated ? <s-text color="subdued">Odoo validated</s-text> : null}
      </s-stack>
      <s-text color="subdued">Checked {new Date(inventory.checkedAt).toLocaleString()}</s-text>
      {!inventory.inventoryValidated ? (
        <s-text color="subdued">Odoo inventory could not be confirmed when this recommendation was generated.</s-text>
      ) : null}

      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
        <thead>
          <tr>
            <th style={TH_STYLE}>Component</th>
            <th style={TH_STYLE}>Oil SKU</th>
            <th style={TH_STYLE}>Ratio</th>
            <th style={TH_STYLE}>Required</th>
            <th style={TH_STYLE}>Odoo Stock</th>
            <th style={TH_STYLE}>Status</th>
          </tr>
        </thead>
        <tbody>
          {inventory.components.map((c, i) => (
            <tr key={i}>
              <td style={TD_STYLE}>{c.productTitle}</td>
              <td style={TD_STYLE}>{c.odooSku || "—"}</td>
              <td style={TD_STYLE}>{Math.round(c.ratioPercent)}%</td>
              <td style={TD_STYLE}>{ML(c.requiredOilMl)}</td>
              <td style={TD_STYLE}>{ML(c.onHandQty)}</td>
              <td style={TD_STYLE}>{c.sufficient == null ? "? Unknown" : c.sufficient ? "✓ Enough" : "✕ Insufficient"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <s-text color="subdued">
        Total fragrance oil: {ML(inventory.oilTotalMl)} · Alcohol: {ML(inventory.alcoholMl)} · Finished bottle:{" "}
        {ML(inventory.oilTotalMl != null && inventory.alcoholMl != null ? inventory.oilTotalMl + inventory.alcoholMl : null)}
      </s-text>
      {inventory.maxBuildableBottles != null ? (
        <s-text color="subdued">Max buildable bottles: {inventory.maxBuildableBottles}</s-text>
      ) : null}
      {inventory.limitingSku ? (
        <s-text color="subdued">
          Limiting oil: {limitingComponent?.productTitle || "—"} — {inventory.limitingSku}
        </s-text>
      ) : null}
      {!inventory.buildable && inventory.inventoryValidated ? (
        <s-text color="subdued">
          Reason: Insufficient oil inventory for {insufficientComponents.map((c) => `${c.productTitle} / ${c.odooSku}`).join(", ")}.
          This candidate was skipped and the recommendation engine evaluated the next ranked candidate.
        </s-text>
      ) : null}
    </s-stack>
  );
}

export default function CustomerDetail() {
  const { profile, updatedAt, recommendations } = useLoaderData();

  return (
    <s-page heading={profile.name || profile.email || "Customer"}>
      <s-link slot="breadcrumb-actions" href="/app">Customers</s-link>

      <s-section heading="Profile">
        <s-stack direction="block" gap="small">
          <s-text>Name: {profile.name || "—"}</s-text>
          <s-text>Email: {profile.email || "—"}</s-text>
          <s-text>
            Location: {[profile.city, profile.stateRegion, profile.country].filter(Boolean).join(", ") || "—"}
          </s-text>
          <s-text>Likes: {profile.likes?.length ? profile.likes.join(", ") : "—"}</s-text>
          <s-text>Dislikes: {profile.dislikes?.length ? profile.dislikes.join(", ") : "—"}</s-text>
          <s-text>Preferred style: {profile.preferredStyle || profile.inferredStyle || "—"}</s-text>
          <s-text>Occasion: {profile.occasion || "—"}</s-text>
          <s-text>Strength preference: {profile.strengthPreference || "—"}</s-text>
          <s-text>
            Season / weather: {profile.requestedSeasonStyle || "—"} / {profile.weatherDirection || "—"}
          </s-text>
          <s-text color="subdued">Last active: {new Date(updatedAt).toLocaleString()}</s-text>
        </s-stack>
      </s-section>

      <s-section heading={`Made combinations (${recommendations.length})`}>
        {recommendations.length === 0 ? (
          <s-paragraph color="subdued">No combinations generated for this customer yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {recommendations.map((r) => {
              const modalId = `confidence-modal-${r.id}`;
              return (
                <s-box key={r.id} padding="base" border="base" borderRadius="base">
                  <s-stack direction="block" gap="small">
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <s-text type="strong">{r.name}</s-text>
                      <s-badge tone="info">{r.combinationType}</s-badge>
                      <s-badge tone={STATUS_TONE[r.status] || "neutral"}>{r.status}</s-badge>
                      {r.confidence ? (
                        <s-clickable command="--show" commandFor={modalId} accessibilityLabel={`Why is confidence ${r.confidence}?`}>
                          <s-badge tone="neutral">confidence: {r.confidence} (why?)</s-badge>
                        </s-clickable>
                      ) : null}
                      {r.status === "confirmed" && r.inventory?.inventoryValidated && r.inventory?.buildable ? (
                        <>
                          <s-badge tone="success">Confirmed</s-badge>
                          <s-badge tone="success">Inventory Verified</s-badge>
                          <s-badge tone="success">Buildable</s-badge>
                        </>
                      ) : null}
                    </s-stack>
                    <s-text color="subdued">Created {new Date(r.createdAt).toLocaleString()}</s-text>
                    <s-text>Ratio: {formatRatios(r.ratios)}</s-text>
                    <s-text>Real components: {formatComponents(r.components)}</s-text>
                    <InventorySection inventory={r.inventory} />
                    {r.whySuits ? <s-text>Why this suits them: {r.whySuits}</s-text> : null}
                    {r.bestUse ? <s-text>Best use: {r.bestUse}</s-text> : null}
                    {r.shopifyProductId ? <s-text color="subdued">Shopify product created</s-text> : null}
                  </s-stack>

                  {r.confidence ? (
                    <s-modal id={modalId} heading={`Why is confidence "${r.confidence}"?`}>
                      <s-stack direction="block" gap="base">
                        {r.confidenceBreakdown ? (
                          <s-stack direction="block" gap="small">
                            <s-text type="strong">Confidence breakdown</s-text>
                            {Object.entries(r.confidenceBreakdown).map(([key, dim]) => (
                              <s-stack key={key} direction="block" gap="extra-tight">
                                <s-stack direction="inline" gap="small" alignItems="center">
                                  <s-text>{CONFIDENCE_DIMENSION_LABELS[key] || key}</s-text>
                                  <s-badge tone={LEVEL_TONE[dim.value] || "neutral"}>{dim.value}</s-badge>
                                </s-stack>
                                <div style={{ background: "#e1e3e5", borderRadius: "4px", height: "8px", width: "100%" }}>
                                  <div
                                    style={{
                                      height: "8px",
                                      borderRadius: "4px",
                                      width: LEVEL_BAR[dim.value]?.width || "0%",
                                      background: LEVEL_BAR[dim.value]?.background || "transparent",
                                    }}
                                  />
                                </div>
                                <s-text color="subdued">{dim.reason}</s-text>
                              </s-stack>
                            ))}
                          </s-stack>
                        ) : null}

                        {r.riskBreakdown.length ? (
                          <s-stack direction="block" gap="small">
                            <s-text type="strong">
                              Risk factors {r.riskPenalty != null ? `(total penalty: ${r.riskPenalty})` : ""}
                            </s-text>
                            <s-stack direction="block" gap="extra-tight">
                              {r.riskBreakdown.map((risk, i) => (
                                <s-text key={i} color={risk.counted ? undefined : "subdued"}>
                                  {risk.counted ? "●" : "○"} {risk.message} — {risk.severity} ({risk.penalty} pts)
                                  {!risk.counted ? " — same root cause as another risk below, not double-counted" : ""}
                                </s-text>
                              ))}
                            </s-stack>
                          </s-stack>
                        ) : null}

                        {r.matchedExactNotes.length || r.missingExactNotes.length ? (
                          <s-stack direction="block" gap="small">
                            <s-text type="strong">
                              Exact note coverage {r.exactNoteCoverageScore != null ? `(+${r.exactNoteCoverageScore} pts)` : ""}
                            </s-text>
                            <s-stack direction="inline" gap="tight">
                              {r.matchedExactNotes.map((n) => (
                                <s-badge key={n} tone="success">{n}</s-badge>
                              ))}
                              {r.missingExactNotes.map((n) => (
                                <s-badge key={n} tone="neutral">missing: {n}</s-badge>
                              ))}
                            </s-stack>
                          </s-stack>
                        ) : null}
                      </s-stack>
                      <s-button slot="primaryAction" variant="primary" command="--hide" commandFor={modalId}>
                        Close
                      </s-button>
                    </s-modal>
                  ) : null}
                </s-box>
              );
            })}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
