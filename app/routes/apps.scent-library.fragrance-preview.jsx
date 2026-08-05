// Fragrance preview page — opened when confirm_product_combination succeeds in chat (see
// fragranceAgentTools.server.js's "preview_ready" event). Shopify product creation is DEFERRED
// until the customer explicitly clicks Save Build or Add to Cart here; nothing is created just by
// viewing this page. Real component product NAMES are never shown inside the Top/Middle/Base note
// rows — only their real notes, bucketed via the one shared app/utils/notePositionMapping.js
// utility — but ARE shown, separately, in the "Products Used" section (formula/evidence
// transparency, per the explicit requirement that real names/IDs stay available to the backend and
// to this kind of secondary display, just never inside the slider rows themselves).
//
// Visual design matched to the deployed custom-scent-product.liquid theme section (the page shown
// AFTER a build is saved) — same fonts/palette/note-row/slider/action-bar language, plus the same
// animated 3D bottle, so Recreate/Save Build/Add to Cart feel like one continuous experience
// rather than a plain page before and a designed one after.
//
// Lives at the exact path the App Proxy exposes on the storefront (see
// shopify.app.shop-chat-agent.toml's [app_proxy]: prefix "apps", subpath "scent-library", url
// ".../apps/scent-library") — Shopify's edge fetches this route server-to-server and relays the
// response back under the merchant's own store domain (https://{shop}/apps/scent-library/
// fragrance-preview) instead of this app's Render URL. Deliberately NOT under /api like this app's
// other proxy-adjacent endpoints (api.save-build.jsx, api.customer-builds.jsx): those are plain
// fetch()-based JSON endpoints with no client-side page to hydrate, so an internal path that
// differs from the public one is harmless. This route renders an interactive React Router page,
// and React's client bundle matches window.location's REAL path (the public one) against its own
// route table to hydrate — a mismatched internal path (it used to live at /api/fragrance-preview)
// made that match fail, so hydration silently aborted and every button/slider on the page went
// dead (confirmed live: page content rendered fine, zero interactivity). Matching the internal
// route path to the public one exactly is what fixes that, not a basename or client-side hack.
//
// authenticate.public.appProxy throws its own 400 on a bad/missing signature, so a request that
// didn't genuinely come through the proxy never reaches the handlers below.
import { useState, useEffect, useMemo, useRef } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getCustomerProfile, saveCustomerProfileFields } from "../services/customerProfile.server";
import {
  computeNotePositionBuckets, computeDefaultRatios, createShopifyBuildProduct,
  markRecommendationDraft, markRecommendationSaved,
  computePricePer5mlByPosition,
} from "../services/fragranceBuild.server";
import { estimateTotalPrice } from "../utils/fragrancePricing";

const POSITION_LABELS = { top: "Top Notes", middle: "Middle Notes", base: "Base Notes" };

export function links() {
  return [
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Work+Sans:wght@300;400;500;600&display=swap",
    },
  ];
}

// Shopify's numeric REST-style ID from a GraphQL GID (e.g. "gid://shopify/ProductVariant/123" ->
// "123") — needed for the cart permalink URL format (/cart/{variantId}:{quantity}).
function numericIdFromGid(gid) {
  const match = String(gid || "").match(/(\d+)$/);
  return match ? match[1] : null;
}

export async function loader({ request }) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    throw new Response("Shop not found.", { status: 401 });
  }

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
  const customerLikes = recommendation.customerProfileJson?.likes || [];
  const buckets = computeNotePositionBuckets(internalProducts, customerLikes);
  const ratios = recommendation.draftRatiosJson || computeDefaultRatios(buckets);
  const customerFacingName = recommendation.customerFacingJson?.customerFacingName || "Custom Blend";

  // Read-only per-position rates (same math createShopifyBuildProduct uses at real creation time)
  // — the component derives a live price estimate from these as the customer drags a slider; the
  // real, authoritative price is only ever set at Save Build/Add to Cart time.
  const ratiosByProduct = Array.isArray(recommendation.ratiosJson) ? recommendation.ratiosJson : [];
  const pricePer5mlByPosition = await computePricePer5mlByPosition(internalProducts, ratiosByProduct);

  // "Molecular Profile" pills — every real note across all three positions, deduped, capped to 8.
  const profilePills = [...new Set([...buckets.top, ...buckets.middle, ...buckets.base])].slice(0, 8);

  return {
    recommendationId,
    name: recommendation.draftName || customerFacingName,
    buckets,
    ratios,
    buildStatus: recommendation.buildStatus,
    shopifyProductId: recommendation.shopifyProductId,
    // Fix (price didn't update while dragging) — exposed so the component can recompute a live
    // estimate as ratios change client-side, via the same shared estimateTotalPrice used below.
    pricePer5mlByPosition,
    profilePills,
    // "Products Used" — real names, shown separately, never inside the note-position rows above.
    productsUsed: internalProducts.map((p) => ({ title: p.title, contribution: p.contribution })),
  };
}

export async function action({ request }) {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) {
    return Response.json({ error: "Shop not found." }, { status: 401 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");
  const recommendationId = formData.get("recommendationId");
  const name = formData.get("name") || null;
  const ratios = JSON.parse(formData.get("ratios") || "null");

  const recommendation = await prisma.fragranceRecommendation.findUnique({ where: { id: recommendationId } });
  if (!recommendation) {
    return Response.json({ error: "Recommendation not found." }, { status: 404 });
  }

  const shopDomain = session.shop;

  if (intent === "recreate") {
    // 1. Save current preview state as an internal draft only — no Shopify product/variant, no
    // cart addition, matches the exact required behaviour.
    await markRecommendationDraft(recommendationId, { name, ratios });
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
    await markRecommendationDraft(recommendationId, { name, ratios });

    let shopifyProductId = recommendation.shopifyProductId;
    let shopifyVariantId = recommendation.shopifyVariantId;
    let productUrl = null;

    try {
      if (!shopifyProductId) {
        // First-time creation — the Top/Middle/Base Note product shape api.save-build.jsx expects.
        const identityProfile = await getCustomerProfile(recommendation.conversationId);
        const result = await createShopifyBuildProduct({
          admin, shopDomain, recommendation,
          customName: name || recommendation.customerFacingJson?.customerFacingName || "Custom Blend",
          ratios,
          customerName: identityProfile.name, customerEmail: identityProfile.email,
        });
        shopifyProductId = result.productId;
        shopifyVariantId = result.variantId;
        productUrl = result.productUrl;
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

        // Save Build now navigates to the real product page, so a re-save on an already-created
        // product needs that product's handle too — one cheap lookup, not stored anywhere else.
        const handleResponse = await admin.graphql(
          `query getProductHandle($id: ID!) { product(id: $id) { handle } }`,
          { variables: { id: shopifyProductId } },
        );
        const handleJson = await handleResponse.json();
        const handle = handleJson.data?.product?.handle;
        productUrl = handle ? `https://${shopDomain}/products/${handle}` : null;
      }
    } catch (err) {
      console.error("fragrance-preview build error:", err);
      return Response.json({ error: err.message || "Failed to save the build." }, { status: 500 });
    }

    await markRecommendationSaved(recommendationId, { shopifyProductId, shopifyVariantId });

    if (intent === "save_build") {
      return Response.json({ status: "saved", shopifyProductId, shopifyVariantId, productUrl });
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

// ============================================================
// Visual design — ported from custom-scent-product.liquid (the post-save product page) so the
// preview feels like the same page, not a plain placeholder before it.
// ============================================================
const PAGE_STYLES = `
  .cs-page {
    --cs-cream: #F6F1EA;
    --cs-ink: #2B2229;
    --cs-wine: #8C4A3C;
    --cs-taupe: #C9BEB0;
    --cs-taupe-light: #E5DED3;
    --cs-white: #FFFFFF;
    background: var(--cs-cream);
    color: var(--cs-ink);
    font-family: 'Work Sans', sans-serif;
    min-height: 100vh;
  }
  .cs-hero {
    display: grid;
    grid-template-columns: 1.1fr 1.3fr 1fr;
    gap: 44px;
    padding: 56px 64px;
    align-items: start;
  }
  .cs-eyebrow {
    font-size: 15px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--cs-wine);
    margin-bottom: 16px;
    opacity: 0;
    animation: cs-fade-up 0.7s ease forwards 0.1s;
  }
  .cs-title-input {
    display: block;
    font-family: 'Cormorant Garamond', serif;
    font-size: 68px;
    line-height: 1.05;
    font-weight: 500;
    margin: 0 0 6px;
    border: none;
    border-bottom: 1px solid transparent;
    background: transparent;
    color: var(--cs-ink);
    width: 100%;
    padding: 0;
    opacity: 0;
    animation: cs-fade-up 0.7s ease forwards 0.25s;
    resize: none;
    overflow: hidden;
    overflow-wrap: break-word;
  }
  .cs-title-input:focus { outline: none; border-bottom-color: var(--cs-taupe); }
  /* Fix (no affordance that the name is editable) — the only signal that this is a real, typeable
     field rather than static heading text. */
  .cs-title-edit-hint {
    font-size: 13px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--cs-wine);
    opacity: 0.75;
    margin: 0 0 22px;
  }
  .cs-notes {
    margin-top: 8px;
    opacity: 0;
    animation: cs-fade-up 0.7s ease forwards 0.4s;
  }
  .cs-note-row { margin-bottom: 28px; }
  .cs-note-label {
    display: flex;
    justify-content: space-between;
    font-size: 17px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 9px;
  }
  .cs-note-pct { font-family: 'Cormorant Garamond', serif; font-size: 19px; letter-spacing: 0; }
  .cs-note-notes-text {
    font-size: 16px;
    opacity: 0.68;
    margin-bottom: 12px;
    line-height: 1.55;
  }

  /* Filled portion drawn via an inline background gradient (percent-driven, one color per
     position — matches the reference page's Top=blue/Middle=gold/Base=wine slider fills) since a
     native range input has no fill pseudo-element of its own to target with pure CSS. */
  .cs-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 14px;
    border-radius: 7px;
    cursor: pointer;
  }
  .cs-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 22px; height: 22px;
    border-radius: 50%;
    background: var(--cs-white);
    border: 3px solid var(--cs-ink);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
    cursor: grab;
  }
  .cs-slider::-moz-range-thumb {
    width: 22px; height: 22px;
    border-radius: 50%;
    background: var(--cs-white);
    border: 3px solid var(--cs-ink);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
    cursor: grab;
  }
  .cs-slider::-moz-range-track { background: transparent; }

  .cs-bottle-stage {
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 78vh;
    background: var(--cs-taupe-light);
    border-radius: 12px;
    opacity: 0;
    animation: cs-fade-in 0.9s ease forwards 0.3s;
  }
  #cs-bottle-3d { width: 100%; height: 100%; min-height: 480px; cursor: grab; }

  .cs-profile { opacity: 0; animation: cs-fade-up 0.7s ease forwards 0.5s; }
  .cs-profile-box {
    border: 1px solid var(--cs-taupe);
    border-radius: 10px;
    padding: 26px;
    margin-bottom: 26px;
  }
  .cs-feature-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 18px;
  }
  .cs-feature-icon {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border: 1px solid var(--cs-taupe);
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
  }
  .cs-feature-title { font-size: 15px; font-weight: 500; }
  .cs-feature-sub { font-size: 13px; color: var(--cs-wine); opacity: 0.9; }

  .cs-loading-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    background: rgba(246, 241, 234, 0.92);
  }
  .cs-loading-spinner {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 3px solid var(--cs-taupe-light);
    border-top-color: var(--cs-wine);
    animation: cs-spin 0.9s linear infinite;
  }
  .cs-loading-text {
    font-family: 'Cormorant Garamond', serif;
    font-size: 20px;
    color: var(--cs-ink);
  }
  @keyframes cs-spin { to { transform: rotate(360deg); } }
  .cs-profile-label {
    font-size: 15px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    opacity: 0.55;
    margin-bottom: 12px;
  }
  .cs-pill-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .cs-pill {
    border: 1px solid var(--cs-taupe);
    border-radius: 20px;
    padding: 6px 13px;
    font-size: 13px;
    letter-spacing: 0.05em;
    text-transform: capitalize;
  }

  .cs-products-used { list-style: none; margin: 0; padding: 0; font-size: 14px; opacity: 0.7; }
  .cs-products-used li { margin-bottom: 4px; }

  .cs-actionbar {
    position: sticky;
    bottom: 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 18px 32px;
    background: var(--cs-white);
    margin: 40px 64px 0;
    box-shadow: 0px 20px 32px 4px rgb(181 181 181 / 35%);
    border: 1px solid #ededed;
    border-radius: 15px;
    width: 60%;
    margin: 0px auto;
  }
  .cs-actionbar-price { display: flex; align-items: baseline; gap: 10px; white-space: nowrap; }
  .cs-actionbar-price .cs-price { font-family: 'Cormorant Garamond', serif; font-size: 38px; }
  .cs-actionbar-price .cs-price-size {
    font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase; opacity: 0.55;
  }
  .cs-actionbar-left, .cs-actionbar-right { display: flex; gap: 12px; align-items: center; }
  .cs-btn-ghost {
    padding: 13px 22px;
    border: 1px solid var(--cs-taupe);
    background: transparent;
    color: var(--cs-ink);
    font-size: 14px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    border-radius: 2px;
    cursor: pointer;
    font-family: 'Work Sans', sans-serif;
    font-weight: 500;
  }
  .cs-btn-ghost:disabled { opacity: 0.5; cursor: default; }
  .cs-btn-primary {
    padding: 13px 34px;
    border: none;
    background: var(--cs-ink);
    color: var(--cs-cream);
    font-size: 14px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-radius: 2px;
    cursor: pointer;
    transition: background 0.25s ease;
  }
  .cs-btn-primary:hover:not(:disabled) { background: var(--cs-wine); }
  .cs-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .cs-error { color: var(--cs-wine); margin: 0 64px; }

  @keyframes cs-fade-up { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes cs-fade-in { from { opacity: 0; } to { opacity: 1; } }

  @media (prefers-reduced-motion: reduce) {
    .cs-eyebrow, .cs-title-input, .cs-notes, .cs-bottle-stage, .cs-profile { animation: none !important; opacity: 1 !important; }
  }

  @media (max-width: 1024px) {
    .cs-hero { grid-template-columns: 1fr; padding: 32px 24px; }
    .cs-title-input { font-size: 40px; }
    .cs-bottle-stage { min-height: 50vh; order: -1; }
    .cs-profile { grid-column: 1 / -1; }
  }
  @media (max-width: 640px) {
    .cs-hero { padding: 20px 16px; }
    .cs-title-input { font-size: 32px; }
    .cs-actionbar { flex-direction: column; align-items: stretch; margin: 0px auto; width: 78%; }
    .cs-actionbar-price { justify-content: center; }
    .cs-actionbar-left, .cs-actionbar-right { justify-content: center; flex-wrap: wrap; }
    .cs-btn-primary { width: 100%; }

#cs-bottle-3d canvas {
    width: 320px;
    height: 260px;
}


  }
`;

// Loads three.js from a CDN at runtime, client-side only — this route has no server/SSR use for
// it, and pulling the whole engine into the app's own npm/Vite bundle for one visualization isn't
// worth it when a dynamic import already does the job, same approach the reference theme section
// itself uses via an import map.
function BottleVisualization({ ratios }) {
  const mountRef = useRef(null);
  const updateFnRef = useRef(null);
  const ratiosRef = useRef(ratios);
  ratiosRef.current = ratios;

  useEffect(() => {
    let disposed = false;
    let renderer = null;
    let animationId = null;
    let cleanup = () => {};

    async function init() {
      // Full unpkg URLs here (not the bare "three" specifier) — Rollup tries to statically
      // resolve a bare specifier at BUILD time even inside a dynamic import and fails, since no
      // "three" package is installed locally; an absolute http(s) URL is left alone for the
      // BROWSER to resolve at runtime instead. The import map rendered in this component's JSX
      // below is only needed for three's OWN addon files (e.g. RoomEnvironment.js), which contain
      // an internal bare `import ... from "three"` that Rollup never sees (it's fetched by the
      // browser at runtime, not bundled) but the browser still needs to resolve.
      const THREE = await import(/* @vite-ignore */ "https://unpkg.com/three@0.160.0/build/three.module.js");
      const { RoomEnvironment } = await import(
        /* @vite-ignore */ "https://unpkg.com/three@0.160.0/examples/jsm/environments/RoomEnvironment.js"
      );
      if (disposed || !mountRef.current) return;
      const mount = mountRef.current;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xe5ded3);

      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
      camera.position.set(0, 1.8, 7.5);
      camera.lookAt(0, 1.5, 0);

      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
      mount.appendChild(renderer.domElement);

      try {
        const pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      } catch (e) {
        console.warn("Environment setup failed, continuing without reflections:", e);
      }

      const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
      keyLight.position.set(3, 6, 4);
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
      fillLight.position.set(-4, 2, -3);
      scene.add(fillLight);
      scene.add(new THREE.AmbientLight(0xffffff, 0.4));

      const bottleGroup = new THREE.Group();
      scene.add(bottleGroup);

      function roundedRectShape(w, h, r) {
        const shape = new THREE.Shape();
        const x = -w / 2, y = -h / 2;
        shape.moveTo(x, y + r);
        shape.lineTo(x, y + h - r);
        shape.quadraticCurveTo(x, y + h, x + r, y + h);
        shape.lineTo(x + w - r, y + h);
        shape.quadraticCurveTo(x + w, y + h, x + w, y + h - r);
        shape.lineTo(x + w, y + r);
        shape.quadraticCurveTo(x + w, y, x + w - r, y);
        shape.lineTo(x + r, y);
        shape.quadraticCurveTo(x, y, x, y + r);
        return shape;
      }

      const BODY_WIDTH = 1.7, BODY_HEIGHT = 2.7, BODY_DEPTH = 0.7, BODY_RADIUS = 0.35;
      const glassShape = roundedRectShape(BODY_WIDTH, BODY_HEIGHT, BODY_RADIUS);
      const glassGeometry = new THREE.ExtrudeGeometry(glassShape, {
        depth: BODY_DEPTH, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06,
        bevelSegments: 6, curveSegments: 16,
      });
      glassGeometry.translate(0, 0, -BODY_DEPTH / 2);

      const glassMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xffffff, transmission: 0.95, thickness: 0.5, roughness: 0.04, ior: 1.5, envMapIntensity: 1.3,
      });
      const glassMesh = new THREE.Mesh(glassGeometry, glassMaterial);
      glassMesh.position.y = BODY_HEIGHT / 2 + 0.1;
      bottleGroup.add(glassMesh);

      const BODY_TOP_Y = BODY_HEIGHT + 0.1;

      const neckGeometry = new THREE.CylinderGeometry(0.32, 0.36, 0.3, 24);
      const neckMesh = new THREE.Mesh(neckGeometry, glassMaterial);
      neckMesh.position.y = BODY_TOP_Y + 0.15;
      bottleGroup.add(neckMesh);

      const collarGeometry = new THREE.CylinderGeometry(0.4, 0.4, 0.1, 24);
      const collarMaterial = new THREE.MeshStandardMaterial({ color: 0xc9a24a, roughness: 0.35, metalness: 0.3 });
      const collarMesh = new THREE.Mesh(collarGeometry, collarMaterial);
      collarMesh.position.y = BODY_TOP_Y + 0.35;
      bottleGroup.add(collarMesh);

      const capGeometry = new THREE.CylinderGeometry(0.42, 0.4, 0.55, 24);
      const capMaterial = new THREE.MeshStandardMaterial({ color: 0xc9a06a, roughness: 0.6, metalness: 0.05 });
      const capMesh = new THREE.Mesh(capGeometry, capMaterial);
      capMesh.position.y = BODY_TOP_Y + 0.35 + 0.325;
      bottleGroup.add(capMesh);

      const LIQUID_BOTTOM_Y = 0.08;
      const LIQUID_TOP_Y = BODY_HEIGHT - 0.15;
      const LIQUID_HEIGHT = LIQUID_TOP_Y - LIQUID_BOTTOM_Y;

      function customRoundedRectShape(w, h, rTL, rTR, rBR, rBL) {
        const shape = new THREE.Shape();
        const x = -w / 2, y = -h / 2;
        shape.moveTo(x, y + rBL);
        shape.lineTo(x, y + h - rTL);
        shape.quadraticCurveTo(x, y + h, x + rTL, y + h);
        shape.lineTo(x + w - rTR, y + h);
        shape.quadraticCurveTo(x + w, y + h, x + w, y + h - rTR);
        shape.lineTo(x + w, y + rBR);
        shape.quadraticCurveTo(x + w, y, x + w - rBR, y);
        shape.lineTo(x + rBL, y);
        shape.quadraticCurveTo(x, y, x, y + rBL);
        return shape;
      }

      function makeHorizontalUVGenerator(width) {
        function uvFromX(x) { return THREE.MathUtils.clamp((x + width / 2) / width, 0, 1); }
        return {
          generateTopUV: function (geometry, vertices, a, b, c) {
            return [
              new THREE.Vector2(uvFromX(vertices[a * 3]), 0.5),
              new THREE.Vector2(uvFromX(vertices[b * 3]), 0.5),
              new THREE.Vector2(uvFromX(vertices[c * 3]), 0.5),
            ];
          },
          generateSideWallUV: function (geometry, vertices, a, b, c, d) {
            return [
              new THREE.Vector2(uvFromX(vertices[a * 3]), 0),
              new THREE.Vector2(uvFromX(vertices[b * 3]), 0),
              new THREE.Vector2(uvFromX(vertices[c * 3]), 1),
              new THREE.Vector2(uvFromX(vertices[d * 3]), 1),
            ];
          },
        };
      }

      function makeGradientTexture(hexStart, hexEnd) {
        const canvas = document.createElement("canvas");
        canvas.width = 64; canvas.height = 4;
        const ctx = canvas.getContext("2d");
        const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
        grad.addColorStop(0, hexStart);
        grad.addColorStop(1, hexEnd);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
      }

      const LAYER_GRADIENTS = {
        top: ["#0a1a4a", "#2655d8"],
        middle: ["#4a2800", "#f09000"],
        base: ["#6B372C", "#8C4A3C"],
      };

      const LIQUID_WIDTH = BODY_WIDTH - 0.08;
      const LIQUID_DEPTH = BODY_DEPTH - 0.08;
      const LIQUID_RADIUS = BODY_RADIUS - 0.03;
      const uvGen = makeHorizontalUVGenerator(LIQUID_WIDTH);

      const topShape = customRoundedRectShape(LIQUID_WIDTH, 1, LIQUID_RADIUS, LIQUID_RADIUS, 0, 0);
      const middleShape = customRoundedRectShape(LIQUID_WIDTH, 1, 0, 0, 0, 0);
      const baseShape = customRoundedRectShape(LIQUID_WIDTH, 1, 0, 0, LIQUID_RADIUS, LIQUID_RADIUS);

      function makeLiquidGeometry(shape) {
        const geo = new THREE.ExtrudeGeometry(shape, {
          depth: LIQUID_DEPTH, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025,
          bevelSegments: 6, curveSegments: 16, UVGenerator: uvGen,
        });
        geo.translate(0, 0, -LIQUID_DEPTH / 2);
        return geo;
      }

      function makeLiquidMesh(shape, gradientStops) {
        const mat = new THREE.MeshPhysicalMaterial({
          map: makeGradientTexture(gradientStops[0], gradientStops[1]),
          roughness: 0.12, clearcoat: 0.6, clearcoatRoughness: 0.08, envMapIntensity: 1.1,
        });
        const mesh = new THREE.Mesh(makeLiquidGeometry(shape), mat);
        mesh.position.y = BODY_HEIGHT / 2 + 0.1;
        bottleGroup.add(mesh);
        return mesh;
      }

      const liquidMeshes = {
        base: makeLiquidMesh(baseShape, LAYER_GRADIENTS.base),
        middle: makeLiquidMesh(middleShape, LAYER_GRADIENTS.middle),
        top: makeLiquidMesh(topShape, LAYER_GRADIENTS.top),
      };

      function updateLiquidLayers(state) {
        const pctByPosition = { top: 0, middle: 0, base: 0 };
        state.forEach((item) => { pctByPosition[item.position] = item.pct; });

        const order = ["base", "middle", "top"];
        let cursorY = LIQUID_BOTTOM_Y;
        const bodyCenterY = BODY_HEIGHT / 2 + 0.1;

        order.forEach((position) => {
          const pct = pctByPosition[position] || 0;
          const h = Math.max(0.001, (pct / 100) * LIQUID_HEIGHT);
          const mesh = liquidMeshes[position];
          mesh.scale.y = h;
          mesh.position.y = bodyCenterY - BODY_HEIGHT / 2 + cursorY + h / 2;
          cursorY += h;
        });
      }

      function resize() {
        const w = mount.clientWidth || 300;
        const h = mount.clientHeight || 500;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      }
      window.addEventListener("resize", resize);
      resize();

      let isDragging = false, lastX = 0, targetRotationY = 0.4, idleTimeout = null, autoRotate = true;
      function onPointerDown(e) {
        isDragging = true;
        autoRotate = false;
        lastX = e.touches ? e.touches[0].clientX : e.clientX;
        mount.style.cursor = "grabbing";
        clearTimeout(idleTimeout);
      }
      function onPointerMove(e) {
        if (!isDragging) return;
        const x = e.touches ? e.touches[0].clientX : e.clientX;
        targetRotationY += (x - lastX) * 0.01;
        lastX = x;
      }
      function onPointerUp() {
        isDragging = false;
        mount.style.cursor = "grab";
        idleTimeout = setTimeout(() => { autoRotate = true; }, 1800);
      }
      mount.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      mount.addEventListener("touchstart", onPointerDown, { passive: true });
      window.addEventListener("touchmove", onPointerMove, { passive: true });
      window.addEventListener("touchend", onPointerUp);

      function animate() {
        animationId = requestAnimationFrame(animate);
        if (autoRotate) targetRotationY += 0.0025;
        bottleGroup.rotation.y += (targetRotationY - bottleGroup.rotation.y) * 0.08;
        renderer.render(scene, camera);
      }
      animate();

      updateFnRef.current = updateLiquidLayers;
      updateLiquidLayers(["top", "middle", "base"].map((position) => ({ position, pct: ratiosRef.current[position] })));

      cleanup = () => {
        clearTimeout(idleTimeout);
        window.removeEventListener("resize", resize);
        mount.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        mount.removeEventListener("touchstart", onPointerDown);
        window.removeEventListener("touchmove", onPointerMove);
        window.removeEventListener("touchend", onPointerUp);
      };
    }

    init().catch((err) => console.error("Bottle visualization failed to load:", err));

    return () => {
      disposed = true;
      cleanup();
      if (animationId) cancelAnimationFrame(animationId);
      if (renderer) {
        renderer.dispose();
        if (mountRef.current?.contains(renderer.domElement)) {
          mountRef.current.removeChild(renderer.domElement);
        }
      }
    };
    // Mounted once — ratio updates flow through updateFnRef below, not by re-running this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (updateFnRef.current) {
      updateFnRef.current(["top", "middle", "base"].map((position) => ({ position, pct: ratios[position] })));
    }
  }, [ratios]);

  return <div id="cs-bottle-3d" ref={mountRef} />;
}

// Fix (title overflow) — a plain single-line <input> never wraps, so a name longer than the
// visible width just got clipped/scrolled off-screen at this heading's large font-size. A
// textarea wraps naturally; this keeps it looking like a single fluid heading by re-measuring and
// setting its own height to its content's real scrollHeight on every change, instead of ever
// scrolling internally the way a real multi-line box would.
function AutoGrowTitleInput({ value, onChange }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      className="cs-title-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Fragrance name"
      rows={1}
    />
  );
}

// Matches the reference page's own per-position slider colors exactly (see LAYER_GRADIENTS in
// BottleVisualization below — same three colors, applied here as a flat 2D fill).
const SLIDER_FILL_COLOR = { top: "#2655d8", middle: "#D9AE68", base: "#8C4A3C" };

function NoteRow({ position, notes, percent, onSlide }) {
  const pct = Math.round(percent);
  return (
    <div className="cs-note-row" data-position={position}>
      <div className="cs-note-label">
        <span>{POSITION_LABELS[position]}</span>
        <span className="cs-note-pct">{pct}%</span>
      </div>
      <div className="cs-note-notes-text">{notes.join(" · ")}</div>
      <input
        type="range" className="cs-slider" min="0" max="100" value={pct}
        onChange={(e) => onSlide(position, Number(e.target.value))}
        style={{ background: `linear-gradient(to right, ${SLIDER_FILL_COLOR[position]} ${pct}%, var(--cs-taupe-light) ${pct}%)` }}
      />
    </div>
  );
}

// Fix (slider stuck at 0%, can't recover) — the previous version redistributed the "remaining"
// percentage among the other two positions PROPORTIONALLY TO THEIR CURRENT VALUE. Once any position
// hit exactly 0, its share of any future redistribution was 0/otherSum = 0 forever — dragging a
// DIFFERENT slider could never give it anything back; only dragging that exact slider's own handle
// could, and even then the math checked out, so the real-world "stuck" symptom was this: a position
// at 0 has no way to recover except by being dragged directly, which reads as broken to a customer
// who naturally drags a different (larger) slider down expecting the empty one to grow.
// Ported from the live custom-scent-product theme section's own redistribute() (same MIN_PCT=5,
// same delta-based approach) for two reasons: it never lets any position reach a true zero-weight
// state in the first place (so this bug class can't recur), and it keeps preview-page dragging
// feeling identical to the real product page.
const MIN_PCT = 5;
function adjustRatios(current, changedKey, newValue) {
  const keys = Object.keys(current);
  const others = keys.filter((k) => k !== changedKey);
  if (others.length === 0) return { ...current, [changedKey]: 100 };

  const maxPct = 100 - MIN_PCT * others.length;
  const newPct = Math.max(MIN_PCT, Math.min(maxPct, newValue));
  const delta = newPct - current[changedKey];

  const updated = { ...current, [changedKey]: newPct };
  const othersTotal = others.reduce((s, k) => s + current[k], 0);
  if (othersTotal > 0) {
    others.forEach((k) => {
      const share = current[k] / othersTotal;
      updated[k] = Math.max(MIN_PCT, current[k] - delta * share);
    });
  }
  const total = keys.reduce((s, k) => s + updated[k], 0);
  updated[changedKey] += 100 - total;

  const rounded = Object.fromEntries(Object.entries(updated).map(([k, v]) => [k, Math.round(v)]));
  const diff = 100 - Object.values(rounded).reduce((a, b) => a + b, 0);
  if (diff !== 0) {
    const largest = Object.entries(rounded).sort((a, b) => b[1] - a[1])[0][0];
    rounded[largest] += diff;
  }
  return rounded;
}

const OVERLAY_MESSAGES = {
  recreate: "Returning to your conversation…",
  save_build: "Creating your fragrance…",
  add_to_cart: "Adding your fragrance to cart…",
};

export default function FragrancePreview() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const [name, setName] = useState(data.name);
  const [ratios, setRatios] = useState(data.ratios);
  const [pendingIntent, setPendingIntent] = useState(null);

  const handleSlide = (position, value) => setRatios((prev) => adjustRatios(prev, position, value));

  // Fix (price didn't update while dragging) — each position now has its own real $/5ml rate
  // (fragranceBuild.server.js's computePricePer5mlByPosition, passed down as
  // data.pricePer5mlByPosition), so the total genuinely changes as ratios move. Recomputed with the
  // same shared estimateTotalPrice the loader used for its initial estimate — never re-implemented.
  const displayPrice = useMemo(
    () => estimateTotalPrice(data.pricePer5mlByPosition, ratios),
    [data.pricePer5mlByPosition, ratios],
  );

  const submit = (intent) => {
    setPendingIntent(intent);
    fetcher.submit(
      { intent, recommendationId: data.recommendationId, name, ratios: JSON.stringify(ratios) },
      { method: "post" },
    );
  };

  // All three intents end in a real browser navigation once the action succeeds — Recreate back
  // to the storefront chat, Save Build to the real product page, Add to Cart to the cart itself —
  // so nothing here needs to update local component state on success, only navigate. An error
  // clears pendingIntent so the loading overlay gives way to the visible error message instead.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.error) {
      setPendingIntent(null);
      return;
    }
    if (fetcher.data.status === "recreate" && fetcher.data.redirectUrl) {
      window.location.href = fetcher.data.redirectUrl;
    } else if (fetcher.data.status === "saved" && fetcher.data.productUrl) {
      window.location.href = fetcher.data.productUrl;
    } else if (fetcher.data.status === "added" && fetcher.data.cartUrl) {
      window.location.href = fetcher.data.cartUrl;
    }
  }, [fetcher.state, fetcher.data]);

  const isBusy = fetcher.state !== "idle" || (pendingIntent && !fetcher.data?.error);

  return (
    <div className="cs-page">
      <style dangerouslySetInnerHTML={{ __html: PAGE_STYLES }} />
      {/* Lets three's own addon modules (e.g. RoomEnvironment.js) resolve their internal bare
          `import ... from "three"` — a direct unpkg URL import in BottleVisualization only
          satisfies imports written by this file, not ones inside three's own addon files. */}
      <script
        type="importmap"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            imports: {
              three: "https://unpkg.com/three@0.160.0/build/three.module.js",
              "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/",
            },
          }),
        }}
      />

      {pendingIntent && !fetcher.data?.error && (
        <div className="cs-loading-overlay">
          <div className="cs-loading-spinner" />
          <div className="cs-loading-text">{OVERLAY_MESSAGES[pendingIntent]}</div>
        </div>
      )}

      <div className="cs-hero">
        <div className="cs-hero-left">
          <div className="cs-eyebrow">The Digital Atelier</div>
          <AutoGrowTitleInput value={name} onChange={setName} />
          {/* Fix (no affordance that the name is editable) — the title looked like plain static
              heading text, with nothing indicating a customer could type over it. */}
          <div className="cs-title-edit-hint">&#9998; Click to rename</div>

          <div className="cs-notes">
            <NoteRow position="top" notes={data.buckets.top} percent={ratios.top} onSlide={handleSlide} />
            <NoteRow position="middle" notes={data.buckets.middle} percent={ratios.middle} onSlide={handleSlide} />
            <NoteRow position="base" notes={data.buckets.base} percent={ratios.base} onSlide={handleSlide} />
          </div>
        </div>

        <div className="cs-bottle-stage">
          <BottleVisualization ratios={ratios} />
        </div>

        <div className="cs-profile">
          <div className="cs-profile-box">
            <div className="cs-profile-label">Molecular Profile</div>
            <div className="cs-pill-grid">
              {data.profilePills.map((note) => (
                <span key={note} className="cs-pill">{note}</span>
              ))}
            </div>
          </div>

          {/* "Products Used" — real component names shown here only, never inside the note rows above. */}
          {/* <div className="cs-profile-box">
            <div className="cs-profile-label">Products Used</div>
            <ul className="cs-products-used">
              {data.productsUsed.map((p) => (
                <li key={p.title}>{p.title}{p.contribution ? ` — ${p.contribution}` : ""}</li>
              ))}
            </ul>
          </div> */}

          <div className="cs-feature-row">
            <div className="cs-feature-icon">&#9879;</div>
            <div>
              <div className="cs-feature-title">Lab Certified</div>
              <div className="cs-feature-sub">Phthalate &amp; Paraben Free</div>
            </div>
          </div>
          <div className="cs-feature-row">
            <div className="cs-feature-icon">&#8734;</div>
            <div>
              <div className="cs-feature-title">Infinite Refills</div>
              <div className="cs-feature-sub">Sustainable Glass Program</div>
            </div>
          </div>
        </div>
      </div>

      {fetcher.data?.error && <p className="cs-error">{fetcher.data.error}</p>}

      <div className="cs-actionbar">
        <div className="cs-actionbar-price">
          <span className="cs-price">${displayPrice.toFixed(2)}</span>
          <span className="cs-price-size">34ML<br />Parfum</span>
        </div>
        <div className="cs-actionbar-left">
          <button type="button" className="cs-btn-ghost" disabled={isBusy} onClick={() => submit("recreate")}>Recreate</button>
          <button type="button" className="cs-btn-ghost" disabled={isBusy} onClick={() => submit("save_build")}>Save Build</button>
        </div>
        <div className="cs-actionbar-right">
          <button type="button" className="cs-btn-primary" disabled={isBusy} onClick={() => submit("add_to_cart")}>Add to Cart</button>
        </div>
      </div>
    </div>
  );
}
