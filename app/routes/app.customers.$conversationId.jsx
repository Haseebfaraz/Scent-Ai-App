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

  const recommendations = await prisma.fragranceRecommendation.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
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
      ratios: Array.isArray(r.ratiosJson) ? r.ratiosJson : [],
      components: Array.isArray(r.productsJson) ? r.productsJson : [],
    })),
  };
}

const STATUS_TONE = { confirmed: "success", pending: "warning", expired: "critical" };

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

export default function CustomerDetail() {
  const { profile, updatedAt, recommendations } = useLoaderData();

  return (
    <s-page heading={profile.name || profile.email || "Customer"}>
      <s-link slot="breadcrumb-actions" href="/app">Customers</s-link>

      <s-section heading="Profile">
        <s-stack direction="block" gap="small">
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
            {recommendations.map((r) => (
              <s-box key={r.id} padding="base" border="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-text type="strong">{r.name}</s-text>
                    <s-badge tone="info">{r.combinationType}</s-badge>
                    <s-badge tone={STATUS_TONE[r.status] || "neutral"}>{r.status}</s-badge>
                    {r.confidence ? <s-badge tone="neutral">confidence: {r.confidence}</s-badge> : null}
                  </s-stack>
                  <s-text color="subdued">Created {new Date(r.createdAt).toLocaleString()}</s-text>
                  <s-text>Ratio: {formatRatios(r.ratios)}</s-text>
                  <s-text>Real components: {formatComponents(r.components)}</s-text>
                  {r.whySuits ? <s-text>Why this suits them: {r.whySuits}</s-text> : null}
                  {r.bestUse ? <s-text>Best use: {r.bestUse}</s-text> : null}
                  {r.shopifyProductId ? <s-text color="subdued">Shopify product created</s-text> : null}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
