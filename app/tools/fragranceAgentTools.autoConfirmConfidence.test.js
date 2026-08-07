// Fix (Phase 15 — no confidence gate before auto-confirmation) — confirmed as a real gap: the
// highest-ranked candidate got auto-confirmed regardless of confidence, so a "low" confidence
// combination (thin data, poor customer fit, or a real compatibility risk) could be presented to
// the customer with exactly the same certainty as a "very high" one.
//
// Fix (persist the gate's own reasoning) — evaluateAutoConfirmEligibility(candidate, profile) is
// the ONE function that decides and explains auto-confirmation; these tests exercise it directly
// with synthetic candidates/profiles, no real generation needed. A hard-dislike conflict needs a
// profile (independent of the candidate's own scoring), so the test hook now takes both.
import { describe, it, expect } from "vitest";
import { __evaluateAutoConfirmEligibilityForTesting as evaluate } from "./fragranceAgentTools.server.js";
import { CUSTOMER_FIT_LOW_THRESHOLD } from "../services/recommendationEngine.server.js";

function candidate(overrides = {}) {
  return {
    type: "HYBRID",
    internalProducts: [
      { title: "A", notes: ["Bergamot", "Lemon"], contribution: "Freshness" },
      { title: "B", notes: ["Vanilla", "Musk"], contribution: "Sweetness" },
    ],
    recommendedRatio: [
      { productTitle: "A", ratioPercent: 50 },
      { productTitle: "B", ratioPercent: 50 },
    ],
    confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "high" }, historical: { value: "low" }, data: { value: "low" }, novelty: { value: "low" } },
    riskBreakdown: [],
    ...overrides,
  };
}

describe("evaluateAutoConfirmEligibility", () => {
  it("auto-confirms strong customer fit with zero history (sparse evidence never blocks)", () => {
    const c = candidate({ confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "high" }, historical: { value: "low" } } });
    const result = evaluate(c, { dislikes: [] });
    expect(result.autoConfirmEligible).toBe(true);
    expect(result.autoConfirmReasons).toEqual([]);
  });

  it("does NOT auto-confirm weak customer fit even with excellent history (a poor match is a bad formula, not thin evidence)", () => {
    const c = candidate({ confidenceBreakdown: { customerFit: { value: "low" }, compatibility: { value: "high" }, historical: { value: "high" } } });
    const result = evaluate(c, { dislikes: [] });
    expect(result.autoConfirmEligible).toBe(false);
    expect(result.autoConfirmReasons).toContain("customer_fit_low");
  });

  it("does NOT auto-confirm good customer fit with poor compatibility", () => {
    const c = candidate({ confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "low" } } });
    const result = evaluate(c, { dislikes: [] });
    expect(result.autoConfirmEligible).toBe(false);
    expect(result.autoConfirmReasons).toContain("compatibility_low");
  });

  it("advisory/low risks do not block", () => {
    const c = candidate({
      confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "medium" } },
      riskBreakdown: [{ counted: true, severity: "advisory" }, { counted: true, severity: "low" }],
    });
    const result = evaluate(c, { dislikes: [] });
    expect(result.autoConfirmEligible).toBe(true);
    expect(result.highestCountedRiskSeverity).toBe("low");
  });

  it("high/critical risks do block", () => {
    const high = candidate({ riskBreakdown: [{ counted: true, severity: "high" }] });
    const highResult = evaluate(high, { dislikes: [] });
    expect(highResult.autoConfirmEligible).toBe(false);
    expect(highResult.autoConfirmReasons).toContain("high_severity_risk:high");

    const critical = candidate({ riskBreakdown: [{ counted: true, severity: "critical" }] });
    const criticalResult = evaluate(critical, { dislikes: [] });
    expect(criticalResult.autoConfirmEligible).toBe(false);
    expect(criticalResult.autoConfirmReasons).toContain("high_severity_risk:critical");
  });

  it("ignores a high-severity risk that was correlation-deduplicated out (counted: false)", () => {
    const c = candidate({ riskBreakdown: [{ counted: false, severity: "high" }] });
    const result = evaluate(c, { dislikes: [] });
    expect(result.autoConfirmEligible).toBe(true);
    expect(result.highestCountedRiskSeverity).toBe(null);
  });

  // A hard dislike is checked independently of the candidate's own score/confidence — it must
  // block even when everything else about the formula reads perfectly.
  it("a hard dislike always blocks, regardless of final score or history", () => {
    const c = candidate({
      internalProducts: [
        { title: "A", notes: ["Sandalwood", "Bergamot"], contribution: "Base" },
        { title: "B", notes: ["Vanilla"], contribution: "Sweetness" },
      ],
      confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "high" }, historical: { value: "high" } },
      riskBreakdown: [],
    });
    const result = evaluate(c, { dislikes: ["Sandalwood"] });
    expect(result.autoConfirmEligible).toBe(false);
    expect(result.autoConfirmReasons).toContain("hard_dislike_conflict");
    expect(result.hasHardDislikeConflict).toBe(true);
  });

  it("a stated family dislike (not a literal note) does not trip the hard-dislike check — that's the existing severity-scaled path", () => {
    const c = candidate({ confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "high" } } });
    const result = evaluate(c, { dislikes: ["Woody fragrances"] });
    expect(result.hasHardDislikeConflict).toBe(false);
  });

  it("blocks an invalid combination shape (ratios that don't sum to 100%) regardless of everything else", () => {
    const c = candidate({
      recommendedRatio: [{ productTitle: "A", ratioPercent: 40 }, { productTitle: "B", ratioPercent: 40 }],
      confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "high" } },
      riskBreakdown: [],
    });
    const result = evaluate(c, { dislikes: [] });
    expect(result.autoConfirmEligible).toBe(false);
    expect(result.autoConfirmReasons).toContain("invalid_shape");
    expect(result.shapeValid).toBe(false);
  });

  it("exposes the actual customer-fit threshold the gate compares against", () => {
    const result = evaluate(candidate(), { dislikes: [] });
    expect(result.customerFitThreshold).toBe(CUSTOMER_FIT_LOW_THRESHOLD);
  });

  it("reports the highest severity among counted risks, not just the first one", () => {
    const c = candidate({
      confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "medium" } },
      riskBreakdown: [{ counted: true, severity: "advisory" }, { counted: true, severity: "medium" }, { counted: true, severity: "low" }],
    });
    const result = evaluate(c, { dislikes: [] });
    expect(result.highestCountedRiskSeverity).toBe("medium");
    expect(result.autoConfirmEligible).toBe(true); // medium never blocks on its own, only high/critical
  });
});
