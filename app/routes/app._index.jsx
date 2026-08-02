// Merchant-facing admin dashboard — every customer who has a saved fragrance profile, searchable
// by email, with a link into their full profile + every combination generated for them (see
// app.customers.$conversationId.jsx). All data here already exists in CustomerProfileState/
// FragranceRecommendation — this page only ever reads it, never collects anything new.
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ponytail: a plain cap instead of real pagination for this first pass — fine for a dev/test
// store's customer count; add cursor-based pagination if this ever needs to scale past a few
// hundred real customers.
const CUSTOMER_ROW_LIMIT = 500;

export async function loader({ request }) {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();

  const rows = await prisma.customerProfileState.findMany({
    orderBy: { updatedAt: "desc" },
    take: CUSTOMER_ROW_LIMIT,
  });

  // Only conversations that actually reached a real, identified customer — an empty/abandoned
  // chat session has no email yet and isn't a "customer" to list here.
  const customers = rows
    .map((row) => ({ conversationId: row.conversationId, updatedAt: row.updatedAt, ...row.profileJson }))
    .filter((c) => c.email);

  const filtered = q
    ? customers.filter((c) => c.email.toLowerCase().includes(q.toLowerCase()))
    : customers;

  const counts = filtered.length
    ? await prisma.fragranceRecommendation.groupBy({
        by: ["conversationId"],
        _count: { id: true },
        where: { conversationId: { in: filtered.map((c) => c.conversationId) } },
      })
    : [];
  const countByConversationId = new Map(counts.map((c) => [c.conversationId, c._count.id]));

  return {
    q,
    totalCustomers: customers.length,
    customers: filtered.map((c) => ({
      conversationId: c.conversationId,
      name: c.name,
      email: c.email,
      city: c.city,
      stateRegion: c.stateRegion,
      country: c.country,
      likes: c.likes || [],
      dislikes: c.dislikes || [],
      preferredStyle: c.preferredStyle,
      occasion: c.occasion,
      updatedAt: c.updatedAt,
      combinationCount: countByConversationId.get(c.conversationId) || 0,
    })),
  };
}

function formatLocation(c) {
  return [c.city, c.stateRegion, c.country].filter(Boolean).join(", ") || "—";
}

function formatList(list) {
  return list && list.length ? list.join(", ") : "—";
}

export default function CustomersIndex() {
  const { q, customers, totalCustomers } = useLoaderData();

  return (
    <s-page heading="Customers">
      <s-section
        heading={
          q
            ? `Customers (${customers.length} of ${totalCustomers} matching "${q}")`
            : `Customers (${totalCustomers})`
        }
      >
        <form method="get">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-search-field
              label="Search by email"
              name="q"
              value={q}
              placeholder="customer@example.com"
            ></s-search-field>
            <s-button type="submit" variant="secondary">Search</s-button>
          </s-stack>
        </form>

        {customers.length === 0 ? (
          <s-paragraph color="subdued">
            {q ? `No customers found matching "${q}".` : "No customers with a saved profile yet."}
          </s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Name</s-table-header>
              <s-table-header>Email</s-table-header>
              <s-table-header>Location</s-table-header>
              <s-table-header>Likes</s-table-header>
              <s-table-header>Dislikes</s-table-header>
              <s-table-header>Style / Occasion</s-table-header>
              <s-table-header>Combinations</s-table-header>
              <s-table-header>Last active</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {customers.map((c) => (
                <s-table-row key={c.conversationId}>
                  <s-table-cell>
                    <s-link href={`/app/customers/${c.conversationId}`}>{c.name || "(no name)"}</s-link>
                  </s-table-cell>
                  <s-table-cell>{c.email}</s-table-cell>
                  <s-table-cell>{formatLocation(c)}</s-table-cell>
                  <s-table-cell>{formatList(c.likes)}</s-table-cell>
                  <s-table-cell>{formatList(c.dislikes)}</s-table-cell>
                  <s-table-cell>{[c.preferredStyle, c.occasion].filter(Boolean).join(" / ") || "—"}</s-table-cell>
                  <s-table-cell>{c.combinationCount}</s-table-cell>
                  <s-table-cell>{new Date(c.updatedAt).toLocaleString()}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
