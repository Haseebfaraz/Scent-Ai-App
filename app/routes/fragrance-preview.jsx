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
import { useState, useEffect, useRef } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { getCustomerProfile, saveCustomerProfileFields } from "../services/customerProfile.server";
import {
  computeNotePositionBuckets, computeDefaultRatios, createShopifyBuildProduct,
  markRecommendationDraft, markRecommendationSaved,
  computeBlendedPricePer5ml, estimateTotalPrice,
} from "../services/fragranceBuild.server";

const DEFAULT_SHOP_DOMAIN = "test-3d-products.myshopify.com";
const POSITION_LABELS = { top: "Top Notes", middle: "Middle Notes", base: "Base Notes" };

export function links() {
  return [
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Work+Sans:wght@300;400;500;600&display=swap",
    },
  ];
}

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

  // Read-only price estimate (same blended-rate math createShopifyBuildProduct uses at real
  // creation time) — shown on the action bar before anything is actually created, purely for
  // display; the real, authoritative price is only ever set at Save Build/Add to Cart time.
  const ratiosByProduct = Array.isArray(recommendation.ratiosJson) ? recommendation.ratiosJson : [];
  const blendedPricePer5ml = await computeBlendedPricePer5ml(internalProducts, ratiosByProduct);
  const estimatedPrice = estimateTotalPrice(blendedPricePer5ml, ratios);

  // "Molecular Profile" pills — every real note across all three positions, deduped, capped to 8.
  const profilePills = [...new Set([...buckets.top, ...buckets.middle, ...buckets.base])].slice(0, 8);

  return {
    recommendationId,
    name: recommendation.draftName || customerFacingName,
    type: recommendation.combinationType,
    buckets,
    ratios,
    excludedNotes,
    buildStatus: recommendation.buildStatus,
    shopifyProductId: recommendation.shopifyProductId,
    estimatedPrice,
    profilePills,
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
    grid-template-columns: 1.1fr 1.3fr;
    gap: 40px;
    padding: 48px 56px;
    align-items: start;
  }
  .cs-eyebrow {
    font-size: 14px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--cs-wine);
    margin-bottom: 14px;
    opacity: 0;
    animation: cs-fade-up 0.7s ease forwards 0.1s;
  }
  .cs-title-input {
    font-family: 'Cormorant Garamond', serif;
    font-size: 56px;
    line-height: 1.05;
    font-weight: 500;
    margin: 0 0 20px;
    border: none;
    border-bottom: 1px solid transparent;
    background: transparent;
    color: var(--cs-ink);
    width: 100%;
    padding: 0;
    opacity: 0;
    animation: cs-fade-up 0.7s ease forwards 0.25s;
  }
  .cs-title-input:focus { outline: none; border-bottom-color: var(--cs-taupe); }
  .cs-type-badge {
    display: inline-block;
    font-size: 12px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--cs-wine);
    border: 1px solid var(--cs-wine);
    border-radius: 20px;
    padding: 4px 12px;
    margin-bottom: 28px;
  }
  .cs-notes {
    margin-top: 8px;
    opacity: 0;
    animation: cs-fade-up 0.7s ease forwards 0.4s;
  }
  .cs-note-row { margin-bottom: 24px; }
  .cs-note-label {
    display: flex;
    justify-content: space-between;
    font-size: 16px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .cs-note-pct { font-family: 'Cormorant Garamond', serif; font-size: 18px; letter-spacing: 0; }
  .cs-note-notes-text {
    font-size: 15px;
    opacity: 0.65;
    margin-bottom: 10px;
    line-height: 1.5;
  }
  .cs-note-notes-text button {
    border: none; background: none; cursor: pointer; padding: 0; font: inherit; color: inherit;
  }
  .cs-note-notes-text button.excluded { text-decoration: line-through; opacity: 0.45; }

  .cs-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 12px;
    border-radius: 6px;
    cursor: pointer;
    background: var(--cs-taupe-light);
  }
  .cs-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 20px; height: 20px;
    border-radius: 50%;
    background: var(--cs-white);
    border: 3px solid var(--cs-ink);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
    cursor: grab;
  }
  .cs-slider::-moz-range-thumb {
    width: 20px; height: 20px;
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
    min-height: 70vh;
    background: var(--cs-taupe-light);
    border-radius: 12px;
    opacity: 0;
    animation: cs-fade-in 0.9s ease forwards 0.3s;
  }
  #cs-bottle-3d { width: 100%; height: 100%; min-height: 480px; cursor: grab; }

  .cs-profile { margin-top: 40px; opacity: 0; animation: cs-fade-up 0.7s ease forwards 0.5s; }
  .cs-profile-box {
    border: 1px solid var(--cs-taupe);
    border-radius: 10px;
    padding: 22px;
    margin-bottom: 24px;
  }
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
    bottom: 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 24px;
    background: var(--cs-white);
    margin: 32px 56px 0;
    box-shadow: 0px 20px 20px 18px rgb(181 181 181 / 30%);
    border: 1px solid #ededed;
    border-radius: 15px;
  }
  .cs-actionbar-price { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
  .cs-actionbar-price .cs-price { font-family: 'Cormorant Garamond', serif; font-size: 32px; }
  .cs-actionbar-price .cs-price-size {
    font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase; opacity: 0.55;
  }
  .cs-actionbar-left, .cs-actionbar-right { display: flex; gap: 10px; align-items: center; }
  .cs-btn-ghost {
    padding: 11px 18px;
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
    padding: 11px 28px;
    border: none;
    background: var(--cs-ink);
    color: var(--cs-cream);
    font-size: 13px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-radius: 2px;
    cursor: pointer;
    transition: background 0.25s ease;
  }
  .cs-btn-primary:hover:not(:disabled) { background: var(--cs-wine); }
  .cs-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .cs-error { color: var(--cs-wine); margin: 0 56px; }

  @keyframes cs-fade-up { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes cs-fade-in { from { opacity: 0; } to { opacity: 1; } }

  @media (prefers-reduced-motion: reduce) {
    .cs-eyebrow, .cs-title-input, .cs-notes, .cs-bottle-stage, .cs-profile { animation: none !important; opacity: 1 !important; }
  }

  @media (max-width: 1024px) {
    .cs-hero { grid-template-columns: 1fr; padding: 32px 24px; }
    .cs-title-input { font-size: 40px; }
    .cs-bottle-stage { min-height: 50vh; order: -1; }
  }
  @media (max-width: 640px) {
    .cs-hero { padding: 20px 16px; }
    .cs-title-input { font-size: 32px; }
    .cs-actionbar { flex-direction: column; align-items: stretch; margin: 24px 16px 0; }
    .cs-actionbar-price { justify-content: center; }
    .cs-actionbar-left, .cs-actionbar-right { justify-content: center; flex-wrap: wrap; }
    .cs-btn-primary { width: 100%; }
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

function NoteRow({ position, notes, percent, excluded, onToggleExclude, onSlide }) {
  return (
    <div className="cs-note-row" data-position={position}>
      <div className="cs-note-label">
        <span>{POSITION_LABELS[position]}</span>
        <span className="cs-note-pct">{Math.round(percent)}%</span>
      </div>
      <div className="cs-note-notes-text">
        {notes.map((note, i) => {
          const isExcluded = excluded.includes(note);
          return (
            <span key={note}>
              {i > 0 ? " · " : ""}
              <button
                type="button"
                className={isExcluded ? "excluded" : ""}
                onClick={() => onToggleExclude(note)}
                title={isExcluded ? "Excluded — click to restore" : "Click to exclude from display"}
              >
                {note}
              </button>
            </span>
          );
        })}
      </div>
      <input
        type="range" className="cs-slider" min="0" max="100" value={Math.round(percent)}
        onChange={(e) => onSlide(position, Number(e.target.value))}
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
  // Price is one blended $/ml rate across the whole 34ml bottle (see
  // fragranceBuild.server.js's computeBlendedPricePer5ml) — dragging Top/Middle/Base sliders
  // redistributes volume WITHIN that same fixed 34ml, so the total never actually moves; showing
  // a "live" recompute here would just be re-deriving the same constant every time.
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

      <div className="cs-hero">
        <div className="cs-hero-left">
          <div className="cs-eyebrow">The Digital Atelier</div>
          <input
            className="cs-title-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Fragrance name"
          />
          <div className="cs-type-badge">{data.type}</div>

          <div className="cs-notes">
            <NoteRow position="top" notes={data.buckets.top} percent={ratios.top} excluded={excludedNotes} onToggleExclude={toggleExclude} onSlide={handleSlide} />
            <NoteRow position="middle" notes={data.buckets.middle} percent={ratios.middle} excluded={excludedNotes} onToggleExclude={toggleExclude} onSlide={handleSlide} />
            <NoteRow position="base" notes={data.buckets.base} percent={ratios.base} excluded={excludedNotes} onToggleExclude={toggleExclude} onSlide={handleSlide} />
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
            <div className="cs-profile-box">
              <div className="cs-profile-label">Products Used</div>
              <ul className="cs-products-used">
                {data.productsUsed.map((p) => (
                  <li key={p.title}>{p.title}{p.contribution ? ` — ${p.contribution}` : ""}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="cs-bottle-stage">
          <BottleVisualization ratios={ratios} />
        </div>
      </div>

      {fetcher.data?.error && <p className="cs-error">{fetcher.data.error}</p>}

      <div className="cs-actionbar">
        <div className="cs-actionbar-price">
          <span className="cs-price">${data.estimatedPrice.toFixed(2)}</span>
          <span className="cs-price-size">34ML<br />Parfum</span>
        </div>
        <div className="cs-actionbar-left">
          <button type="button" className="cs-btn-ghost" disabled={isBusy} onClick={() => submit("recreate")}>Recreate</button>
          <button type="button" className="cs-btn-ghost" disabled={isBusy} onClick={() => submit("save_build")}>
            {savedState === "saved" ? "Saved" : "Save Build"}
          </button>
        </div>
        <div className="cs-actionbar-right">
          <button type="button" className="cs-btn-primary" disabled={isBusy} onClick={() => submit("add_to_cart")}>Add to Cart</button>
        </div>
      </div>
    </div>
  );
}
