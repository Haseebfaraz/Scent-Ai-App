// Phase 8 — this route is now a thin proxy to the standalone Python FastAPI backend (a separate
// repository + separate Render service — see docs/PYTHON_MIGRATION_AUDIT.md), which owns
// conversation memory, the OpenAI call, the tool-resolution loop, and all fragrance/
// recommendation/Odoo logic. Node keeps only what's genuinely Shopify-specific: the public
// CORS/OPTIONS contract the storefront widget already depends on, and resolving this shop's real
// domain (from the Session table, which Python has no access to) to pass through as shop_domain.
//
// The SSE event contract emitted here is byte-identical to before this proxy existed — FastAPI's
// /internal/chat produces the exact same frames (id, profile_progress, analysis_progress,
// candidate_products, combination_recommendations, recommendation_selected, preview_ready, chunk,
// message_complete, end_turn, error) this route used to assemble itself; the widget needs no
// changes at all.
import { resolveShopDomain } from "../services/shopDomain.server";

// Kept as a pure, exported function ONLY so the pre-existing chatFlow.test.js regression test
// still passes — the route body below no longer calls this (Python's app/ai/prompt.py has the
// real, live has_concrete_context that now actually drives the system prompt).
const CONCRETE_CONTEXT_PATTERN = new RegExp(
  "\\b(" +
  [
    "perfume", "fragrance", "cologne", "scent", "smell",
    "wedding", "birthday", "anniversary", "date", "party", "event", "vacation", "trip", "holiday",
    "interview", "presentation", "gift", "present",
    "husband", "wife", "boyfriend", "girlfriend", "fiance", "fiancee",
  ].join("|") +
  ")\\b",
  "i",
);
export function hasConcreteContext(text) {
  return typeof text === "string" && CONCRETE_CONTEXT_PATTERN.test(text);
}

const PYTHON_BACKEND_URL = process.env.PYTHON_BACKEND_URL || "http://localhost:8000";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
// A hung/unreachable Python service must never leave the widget's fetch waiting indefinitely --
// Python itself bounds every outbound call it makes (OpenAI/DB/Odoo), but this hop had no bound
// of its own.
const PYTHON_BACKEND_TIMEOUT_MS = 45_000;

function internalHeaders(extra = {}) {
  return {
    ...extra,
    ...(INTERNAL_API_KEY ? { "X-Internal-Api-Key": INTERNAL_API_KEY } : {}),
  };
}

const CHAT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Shopify-Shop-Id, ngrok-skip-browser-warning",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

// ============================================================
// LOADER — handles history fetch (GET) requests
// ============================================================
export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CHAT_CORS_HEADERS });
  }

  const url = new URL(request.url);
  const isHistoryRequest = url.searchParams.get("history") === "true";
  const conversationId = url.searchParams.get("conversation_id");

  if (!isHistoryRequest) {
    return new Response(JSON.stringify({ messages: [] }), {
      status: 200,
      headers: { ...CHAT_CORS_HEADERS, "Content-Type": "application/json" }
    });
  }

  try {
    const pythonUrl = new URL("/internal/chat/history", PYTHON_BACKEND_URL);
    if (conversationId) pythonUrl.searchParams.set("conversation_id", conversationId);

    const response = await fetch(pythonUrl, { headers: internalHeaders(), signal: AbortSignal.timeout(PYTHON_BACKEND_TIMEOUT_MS) });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { ...CHAT_CORS_HEADERS, "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("Failed to reach Python backend for chat history:", err.message);
    return new Response(JSON.stringify({ messages: [] }), {
      status: 200,
      headers: { ...CHAT_CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
}

// ============================================================
// ACTION — handles incoming chat messages (POST), proxied to Python
// ============================================================
export async function action({ request }) {
  const corsHeaders = CHAT_CORS_HEADERS;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await request.json();
    const shopDomain = await resolveShopDomain();

    const pythonResponse = await fetch(new URL("/internal/chat", PYTHON_BACKEND_URL), {
      method: "POST",
      headers: internalHeaders({ "Content-Type": "application/json" }),
      signal: AbortSignal.timeout(PYTHON_BACKEND_TIMEOUT_MS),
      body: JSON.stringify({
        conversation_id: body.conversation_id || null,
        message: body.message || "",
        customer_email: body.customer_email || null,
        customer_name: body.customer_name || null,
        greeting: body.greeting || null,
        shop_domain: shopDomain,
      }),
    });

    if (!pythonResponse.ok || !pythonResponse.body) {
      throw new Error(`Python backend returned ${pythonResponse.status}`);
    }

    // Direct pass-through of the SSE stream — Python already assembles the exact same frames
    // this route used to build itself, so there's nothing to re-parse or transform here.
    return new Response(pythonResponse.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (err) {
    console.error("Action error (Python backend unreachable or failed):", err);
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: "Error processing request." })}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  }
}
