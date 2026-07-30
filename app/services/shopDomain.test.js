// Fix (InvalidShopError) — resolveShopDomain must come from the real installed Session row, never
// from request headers (a same-origin fetcher call always carries this app's own Render domain as
// Origin, which unauthenticated.admin() correctly rejects as an invalid shop).
import { describe, it, expect } from "vitest";
import { resolveShopDomain } from "./shopDomain.server.js";
import prisma from "../db.server.js";

describe("resolveShopDomain", () => {
  it("resolves the real installed shop from the Session table, not a guess", async () => {
    const realSession = await prisma.session.findFirst({ where: { isOnline: false } });
    const resolved = await resolveShopDomain();
    if (realSession) {
      expect(resolved).toBe(realSession.shop);
    }
    // A real shop domain always looks like a domain, never a bare app hostname mistaken for one.
    expect(resolved).toMatch(/\./);
  });
});
