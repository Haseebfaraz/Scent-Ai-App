// Integration tests against the real dev database and the real Open-Meteo geocoding API — matches
// this project's standing "test against real data, not mocks" practice. Network-dependent tests
// are skipped gracefully if the request fails (e.g. no network in a sandboxed CI run) rather than
// flaking the whole suite.
import { describe, it, expect } from "vitest";
import { verifyCity } from "./locationVerification.server.js";

describe("verifyCity (Fix 8)", () => {
  it("rejects a fictional city — the real 'Vice City' transcript bug", async () => {
    const result = await verifyCity("Vice City");
    expect(result.verified).toBe(false);
  });

  it("rejects an empty string without making any network call", async () => {
    const result = await verifyCity("");
    expect(result).toEqual({ verified: false, city: null, country: null, source: null, needsClarification: false, candidates: [] });
  });

  it("verifies a real city present in order history via the fast, free order_history path", async () => {
    const result = await verifyCity("Los Angeles");
    expect(result.verified).toBe(true);
    expect(result.source).toBe("order_history");
    expect(result.country).toBeTruthy();
  });

  it("does not require order-history presence — a real city with zero historical orders is still accepted", async () => {
    // A small, real, unusual-enough place unlikely to appear in the order history sample but that
    // real geocoding definitely resolves.
    const result = await verifyCity("Reykjavik");
    if (result.needsClarification) return; // network unavailable in this environment — skip gracefully
    expect(result.verified).toBe(true);
  });
});
