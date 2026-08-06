// Fix (Phase 15 — no confidence gate before auto-confirmation) — confirmed as a real gap: the
// highest-ranked candidate got auto-confirmed regardless of confidence, so a "low" confidence
// combination (thin data, poor customer fit, or a real compatibility risk) could be presented to
// the customer with exactly the same certainty as a "very high" one. Tests the gating decision
// directly with synthetic candidates — no need for a real generation to happen to produce one of
// each confidence level.
import { describe, it, expect } from "vitest";
import { __isEligibleForAutoConfirmationForTesting as isEligible } from "./fragranceAgentTools.server.js";

describe("isEligibleForAutoConfirmation", () => {
  // Round 1 (Phase 15 clarification) — "low" confidence alone must NOT block; it's the ordinary
  // outcome for a customer without deep historical evidence, not a rare edge case. Only a real,
  // counted high/critical-severity risk blocks auto-confirmation.
  it("auto-confirms a low-confidence candidate that carries no counted high-severity risk", () => {
    expect(isEligible({ confidence: "low", riskBreakdown: [] })).toBe(true);
  });

  it("rejects a low-confidence candidate carrying a counted high-severity risk", () => {
    expect(isEligible({ confidence: "low", riskBreakdown: [{ counted: true, severity: "high" }] })).toBe(false);
  });

  it("always auto-confirms a very-high or high confidence candidate", () => {
    expect(isEligible({ confidence: "very high", riskBreakdown: [] })).toBe(true);
    expect(isEligible({ confidence: "high", riskBreakdown: [] })).toBe(true);
  });

  // Round 2 (evidence-based follow-up) — a medium-confidence customer-fit requirement is itself a
  // "thin evidence" gate, the same class of block round 1 already ruled out for "low". Confirmed
  // live: it reproduced the exact same "every candidate too low-confidence" failure for an ordinary
  // Fruity-only customer after a refinement, since real medium-confidence candidates routinely carry
  // customerFit "low"/"medium", not "high". The gate is unified to risk alone, at every tier.
  it("auto-confirms a medium-confidence candidate with weak customer fit as long as it carries no high-severity risk", () => {
    const weakFitMedium = { confidence: "medium", confidenceBreakdown: { customerFit: { value: "medium" } }, riskBreakdown: [] };
    expect(isEligible(weakFitMedium)).toBe(true);
  });

  it("rejects a medium-confidence candidate carrying a counted high-severity risk, even with high customer fit", () => {
    const riskyMedium = {
      confidence: "medium",
      confidenceBreakdown: { customerFit: { value: "high" } },
      riskBreakdown: [{ counted: true, severity: "high" }],
    };
    expect(isEligible(riskyMedium)).toBe(false);
  });

  it("ignores a high-severity risk that was correlation-deduplicated out (counted: false)", () => {
    const dedupedRisk = {
      confidence: "medium",
      confidenceBreakdown: { customerFit: { value: "high" } },
      riskBreakdown: [{ counted: false, severity: "high" }],
    };
    expect(isEligible(dedupedRisk)).toBe(true);
  });
});
