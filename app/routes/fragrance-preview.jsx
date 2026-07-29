// Fragrance preview page — opened when confirm_product_combination succeeds in chat (see
// fragranceAgentTools.server.js's "preview_ready" event). Shopify product creation is DEFERRED
// until the customer explicitly clicks Save Build or Add to Cart here; nothing is created just by
// viewing this page. Real component product NAMES are never shown inside the Top/Middle/Base note
// rows — only their real notes, bucketed via the one shared app/utils/notePositionMapping.js
// utility — but ARE shown, separately, in the "Products Used" section (formula/evidence
// transparency, per the explicit requirement that real names/IDs stay available to the backend and
// to this kind of secondary display, just never inside the slider rows themselves).
import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { getCustomerProfile, saveCustomerProfileFields } from "../services/customerProfile.server";
import {
  computeNotePositionBuckets, computeDefaultRatios, createShopifyBuildProduct,
  markRecommendationDraft, markRecommendationSaved,
} from "../services/fragranceBuild.server";

const DEFAULT_SHOP_DOMAIN = "test-3d-products.myshopify.com";
const POSITION_LABELS = { top: "Top Notes", middle: "Middle Notes", base: "Base Notes" };

function resolveShopDomain(request) {
  const originHeader = request.headers.get("Origin") || request.headers.get("Referer") || "";
  const domain = originHeader.replace(/^https?:\/\//, "").split("/")[0];
  return domain && domain.includes(".") ? domain : DEFAULT_SHOP_DOMAIN;
}

// Shopify's numeric REST-style ID from a GraphQL GID (e.g. "gid://shopify/ProductVariant/123" ->
// "123") — needed for the cart permalink URL format (/cart/{variantId}:{quantity}).
function numericIdFromGid(gid) {
  const match = String(gid || "").match(/(\d+)$/);
  return match ? match[1] : null;
}

export async function loader({ request }) {
  const url = new URL(request.url);
  const recommendationId = url.searchParams.get("recommendationId");
  if (!recommendationId) {
    throw new Response("recommendationId is required", { status: 400 });
  }

  const recommendation = await prisma.fragranceRecommendation.findUnique({ where: { id: recommendationId } });
  if (!recommendation) {
    throw new Response("Recommendation not found", { status: 404 });
  }

  const internalProducts = Array.isArray(recommendation.productsJson) ? recommendation.productsJson : [];
  const excludedNotes = Array.isArray(recommendation.draftExcludedNotes) ? recommendation.draftExcludedNotes : [];
  const buckets = computeNotePositionBuckets(internalProducts, excludedNotes);
  const ratios = recommendation.draftRatiosJson || computeDefaultRatios(buckets);
  const customerFacingName = recommendation.customerFacingJson?.customerFacingName || "Custom Blend";

  return {
    recommendationId,
    name: recommendation.draftName || customerFacingName,
    type: recommendation.combinationType,
    buckets,
    ratios,
    excludedNotes,
    buildStatus: recommendation.buildStatus,
    shopifyProductId: recommendation.shopifyProductId,
    // "Products Used" — real names, shown separately, never inside the note-position rows above.
    productsUsed: internalProducts.map((p) => ({ title: p.title, contribution: p.contribution })),
  };
}

export async function action({ request }) {
  const formData = await request.formData();
  const intent = formData.get("intent");
  const recommendationId = formData.get("recommendationId");
  const name = formData.get("name") || null;
  const excludedNotes = JSON.parse(formData.get("excludedNotes") || "[]");
  const ratios = JSON.parse(formData.get("ratios") || "null");

  const recommendation = await prisma.fragranceRecommendation.findUnique({ where: { id: recommendationId } });
  if (!recommendation) {
    return Response.json({ error: "Recommendation not found." }, { status: 404 });
  }

  const shopDomain = resolveShopDomain(request);

  if (intent === "recreate") {
    // 1. Save current preview state as an internal draft only — no Shopify product/variant, no
    // cart addition, matches the exact required behaviour.
    await markRecommendationDraft(recommendationId, { name, excludedNotes, ratios });
    // 2. Flag this conversation so chat.jsx's history loader asks "What would you like to change
    // about your fragrance?" the next time it's resumed (the widget already persists
    // conversationId in sessionStorage and auto-resumes it on load — no URL param needed).
    await saveCustomerProfileFields(recommendation.conversationId, { pendingRecreateRecommendationId: recommendationId });
    // Returned as JSON (not a raw HTTP redirect) because this action is invoked via a fetcher —
    // fetch() follows redirects internally without touching the browser's actual location, so the
    // client below does the navigation itself (same pattern as the add_to_cart cartUrl below).
    return Response.json({ status: "recreate", redirectUrl: `https://${shopDomain}/` });
  }

  if (intent === "save_build" || intent === "add_to_cart") {
    await markRecommendationDraft(recommendationId, { name, excludedNotes, ratios });

    let shopifyProductId = recommendation.shopifyProductId;
    let shopifyVariantId = recommendation.shopifyVariantId;

    try {
      if (!shopifyProductId) {
        // First-time creation — the Top/Middle/Base Note product shape api.save-build.jsx expects.
        const { admin } = await unauthenticated.admin(shopDomain);
        const identityProfile = await getCustomerProfile(recommendation.conversationId);
        const result = await createShopifyBuildProduct({
          admin, shopDomain, recommendation,
          customName: name || recommendation.customerFacingJson?.customerFacingName || "Custom Blend",
          ratios, excludedNotes,
          customerName: identityProfile.name, customerEmail: identityProfile.email,
        });
        shopifyProductId = result.productId;
        shopifyVariantId = result.variantId;
      } else {
        // A product already exists — reuse the existing, already-correct endpoint exactly as it
        // was designed for (resolve or create the variant matching this ratio), rather than
        // duplicating its tolerance-matching/pricing logic here.
        const saveBuildResponse = await fetch(`${new URL(request.url).origin}/api/save-build`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: `https://${shopDomain}` },
          body: JSON.stringify({ productId: shopifyProductId, ratios }),
        });
        const saveBuildJson = await saveBuildResponse.json();
        if (saveBuildJson.error) throw new Error(saveBuildJson.error);
        shopifyVariantId = saveBuildJson.variantId;
      }
    } catch (err) {
      console.error("fragrance-preview build error:", err);
      return Response.json({ error: err.message || "Failed to save the build." }, { status: 500 });
    }

    await markRecommendationSaved(recommendationId, { shopifyProductId, shopifyVariantId });

    if (intent === "save_build") {
      return Response.json({ status: "saved", shopifyProductId, shopifyVariantId });
    }

    // Add to Cart — Shopify's cart permalink adds the variant AND opens the cart in one
    // navigation; no cross-origin cart-cookie handling needed since the browser navigates
    // directly to the shop's own domain.
    const numericVariantId = numericIdFromGid(shopifyVariantId);
    return Response.json({
      status: "added",
      shopifyProductId, shopifyVariantId,
      cartUrl: `https://${shopDomain}/cart/${numericVariantId}:1`,
    });
  }

  return Response.json({ error: `Unknown intent "${intent}".` }, { status: 400 });
}

function NoteRow({ position, notes, percent, excluded, onToggleExclude, onSlide }) {
  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
        <span>{POSITION_LABELS[position]}</span>
        <span>{Math.round(percent)}%</span>
      </div>
      <p style={{ margin: "0.25rem 0", color: "#555" }}>
        {notes.map((note, i) => {
          const isExcluded = excluded.includes(note);
          return (
            <span key={note}>
              {i > 0 ? " · " : ""}
              <button
                type="button"
                onClick={() => onToggleExclude(note)}
                title={isExcluded ? "Excluded — click to restore" : "Click to exclude from display"}
                style={{
                  border: "none", background: "none", cursor: "pointer", padding: 0,
                  textDecoration: isExcluded ? "line-through" : "none",
                  opacity: isExcluded ? 0.4 : 1, font: "inherit",
                }}
              >
                {note}
              </button>
            </span>
          );
        })}
      </p>
      <input
        type="range" min="0" max="100" value={Math.round(percent)}
        onChange={(e) => onSlide(position, Number(e.target.value))}
        style={{ width: "100%" }}
      />
    </div>
  );
}

// Redistributes the other two positions proportionally so all three always sum to exactly 100 —
// never lets one slider move without the others compensating.
function adjustRatios(current, changedKey, newValue) {
  const others = Object.keys(current).filter((k) => k !== changedKey);
  const clamped = Math.max(0, Math.min(100, newValue));
  const remaining = 100 - clamped;
  const otherSum = others.reduce((s, k) => s + current[k], 0);
  const updated = { ...current, [changedKey]: clamped };
  if (otherSum <= 0) {
    others.forEach((k, i) => { updated[k] = i === 0 ? remaining : 0; });
  } else {
    others.forEach((k) => { updated[k] = (current[k] / otherSum) * remaining; });
  }
  const rounded = Object.fromEntries(Object.entries(updated).map(([k, v]) => [k, Math.round(v)]));
  const diff = 100 - Object.values(rounded).reduce((a, b) => a + b, 0);
  if (diff !== 0) {
    const largest = Object.entries(rounded).sort((a, b) => b[1] - a[1])[0][0];
    rounded[largest] += diff;
  }
  return rounded;
}

export default function FragrancePreview() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const [name, setName] = useState(data.name);
  const [ratios, setRatios] = useState(data.ratios);
  const [excludedNotes, setExcludedNotes] = useState(data.excludedNotes);
  const [savedState, setSavedState] = useState(data.buildStatus === "saved" ? "saved" : "idle");

  const toggleExclude = (note) => {
    setExcludedNotes((prev) => (prev.includes(note) ? prev.filter((n) => n !== note) : [...prev, note]));
  };
  const handleSlide = (position, value) => setRatios((prev) => adjustRatios(prev, position, value));

  const submit = (intent) => {
    if (intent === "save_build") setSavedState("saving");
    fetcher.submit(
      {
        intent, recommendationId: data.recommendationId, name,
        excludedNotes: JSON.stringify(excludedNotes), ratios: JSON.stringify(ratios),
      },
      { method: "post" },
    );
  };

  if (fetcher.data?.status === "saved" && savedState !== "saved") setSavedState("saved");
  if (fetcher.data?.status === "recreate" && fetcher.data.redirectUrl) {
    window.location.href = fetcher.data.redirectUrl;
  }
  if (fetcher.data?.status === "added" && fetcher.data.cartUrl) {
    window.location.href = fetcher.data.cartUrl;
  }

  const isBusy = fetcher.state !== "idle";

  return (
    <div style={{ maxWidth: 560, margin: "2rem auto", fontFamily: "system-ui, sans-serif", padding: "0 1rem" }}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ fontSize: "1.5rem", fontWeight: 700, border: "none", borderBottom: "1px solid #ddd", width: "100%", marginBottom: "0.25rem" }}
      />
      <p style={{ color: "#888", marginTop: 0 }}>{data.type}</p>

      <NoteRow position="top" notes={data.buckets.top} percent={ratios.top} excluded={excludedNotes} onToggleExclude={toggleExclude} onSlide={handleSlide} />
      <NoteRow position="middle" notes={data.buckets.middle} percent={ratios.middle} excluded={excludedNotes} onToggleExclude={toggleExclude} onSlide={handleSlide} />
      <NoteRow position="base" notes={data.buckets.base} percent={ratios.base} excluded={excludedNotes} onToggleExclude={toggleExclude} onSlide={handleSlide} />

      {fetcher.data?.error && <p style={{ color: "#b00020" }}>{fetcher.data.error}</p>}

      <div style={{ display: "flex", gap: "0.75rem", marginTop: "1.5rem" }}>
        <button type="button" disabled={isBusy} onClick={() => submit("recreate")}>Recreate</button>
        <button type="button" disabled={isBusy} onClick={() => submit("save_build")}>
          {savedState === "saved" ? "Saved" : "Save Build"}
        </button>
        <button type="button" disabled={isBusy} onClick={() => submit("add_to_cart")}>Add to Cart</button>
      </div>

      {/* "Products Used" — real component names shown here only, never inside the note rows above. */}
      <div style={{ marginTop: "2rem", borderTop: "1px solid #eee", paddingTop: "1rem" }}>
        <h4 style={{ marginBottom: "0.5rem" }}>Products Used</h4>
        <ul style={{ margin: 0, paddingLeft: "1.2rem", color: "#555" }}>
          {data.productsUsed.map((p) => (
            <li key={p.title}>{p.title}{p.contribution ? ` — ${p.contribution}` : ""}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
