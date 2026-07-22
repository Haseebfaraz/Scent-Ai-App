// ponytail: simplified from the App Proxy version to avoid the tunnel requirement — trusts the
// email sent directly from the browser instead of Shopify's cryptographically-verified customer
// identity. Ceiling: anyone with devtools can pass a different email and see that customer's
// saved builds (name, email, blend details). Fine for a dev/test store; before real customers
// use this, swap back to authenticate.public.appProxy() (see git history / conversation) so the
// identity is verified server-side instead of trusted from the client.
import { unauthenticated } from "../shopify.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
};

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);
  const email = url.searchParams.get("email");
  const shopDomain = url.searchParams.get("shop_domain") || "test-3d-products.myshopify.com";

  if (!email) {
    return new Response(JSON.stringify({ builds: [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  let admin = null;
  try {
    const result = await unauthenticated.admin(shopDomain);
    admin = result.admin;
  } catch (err) {
    console.error("customer-builds admin lookup failed:", err.message);
  }

  if (!admin) {
    return new Response(JSON.stringify({ error: "Shop session not found." }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Shopify only indexes a metafield for `query:` search once a formal metafield DEFINITION
  // exists for that namespace/key — we've only ever set ad-hoc values via productCreate, so
  // Shopify had nothing to filter on and silently returned every product. Creating the
  // definition is idempotent (Shopify errors if it already exists; we just ignore that) and
  // applies retroactively to every product that already has this metafield set.
  await admin.graphql(`
    mutation ensureCustomerEmailDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id }
        userErrors { field message code }
      }
    }
  `, {
    variables: {
      definition: {
        name: "Customer Email",
        namespace: "custom",
        key: "customer_email",
        type: "single_line_text_field",
        ownerType: "PRODUCT"
      }
    }
  });

  // Shopify's search DSL uses double quotes for exact-value matching — single quotes don't
  // parse as a filter for a value containing "@"/"." and it silently falls back to no filter
  // at all (returning every product), which is what was happening before this fix.
  const escapedEmail = email.replace(/"/g, '\\"');
  const searchQuery = `metafields.custom.customer_email:"${escapedEmail}"`;

  const productsResponse = await admin.graphql(`
    query getCustomerBuilds($query: String!) {
      products(first: 50, query: $query) {
        nodes {
          title
          handle
          featuredImage { url }
          priceRangeV2 { minVariantPrice { amount currencyCode } }
        }
      }
    }
  `, { variables: { query: searchQuery } });
  const productsJson = await productsResponse.json();
  console.log("customer-builds search:", JSON.stringify({ searchQuery, resultCount: productsJson.data?.products?.nodes?.length, errors: productsJson.errors }));

  const builds = (productsJson.data?.products?.nodes || []).map(p => ({
    title: p.title,
    handle: p.handle,
    image: p.featuredImage?.url || null,
    price: p.priceRangeV2?.minVariantPrice?.amount,
    currency: p.priceRangeV2?.minVariantPrice?.currencyCode
  }));

  return new Response(JSON.stringify({ builds }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
