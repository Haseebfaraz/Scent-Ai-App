// Unlike most services in this repo (which test against real data — see e.g.
// locationVerification.test.js), this module wraps a real LLM call whose output is inherently
// non-deterministic: verified directly in manual testing that eliciting a specific violation
// (e.g. a "This ..." opener) from a real model sometimes took up to a dozen live attempts. A test
// suite that needs a dozen live API calls to reliably exercise one branch isn't viable for CI, so
// fetch is mocked here specifically to make the deterministic BRANCHING logic (leak-check, "never
// start with This" check, one-retry repair, fallback-on-any-failure, distinct per-retry angles)
// reliably testable — not to test what OpenAI itself returns, which isn't ours to test.
import { describe, it, expect, afterAll, vi } from "vitest";
import { applyCustomerFacingCopy } from "./fragranceCopyGeneration.server.js";

const originalFetch = global.fetch;
afterAll(() => {
  global.fetch = originalFetch;
});

function mockOkResponse(content) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
}

function makeItem(overrides = {}) {
  return {
    proposal: {
      confidence: "medium",
      evidenceScope: "limited",
      customerFacingDescription: "FALLBACK_DESC",
      customerFacingWhySuits: "FALLBACK_WHY",
      canonicalKey: "fallback-key",
      ...overrides,
    },
    notesByRole: { Freshness: ["Bergamot", "Lime"] },
  };
}
const PROFILE_FIELDS = { likes: ["Fresh"], dislikes: [] };

describe("applyCustomerFacingCopy — leak-guard rejection", () => {
  it("rejects a response containing a real catalog title, and leaves the caller's fallback untouched (no retry)", async () => {
    let fetchCalls = 0;
    global.fetch = vi.fn(async () => {
      fetchCalls++;
      return mockOkResponse({ description: "A blend built around Secret Real Product", whySuits: "Great for you" });
    });
    const item = makeItem();
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, ["secret real product"]);

    expect(item.proposal.customerFacingDescription).toBe("FALLBACK_DESC");
    expect(item.proposal.customerFacingWhySuits).toBe("FALLBACK_WHY");
    // Leak-check failures are a hard reject, not retried — confirms exactly one call was made.
    expect(fetchCalls).toBe(1);
  });

  it("rejects a response matching the internal-ID pattern, and leaves the caller's fallback untouched", async () => {
    global.fetch = vi.fn(async () =>
      mockOkResponse({ description: "cabc123456789012345678xyz is lovely", whySuits: "Great for you" }),
    );
    const item = makeItem();
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);

    expect(item.proposal.customerFacingDescription).toBe("FALLBACK_DESC");
    expect(item.proposal.customerFacingWhySuits).toBe("FALLBACK_WHY");
  });
});

// Fix (protect customer-facing copy) — the copy model is told to reference the customer's stated
// likes, but nothing stopped it claiming a SPECIFIC named note on a combination that doesn't
// actually contain it — confirmed live, a real "why this suits them" line claimed "your love for
// apple" on a combo with no Apple anywhere in its real notes.
describe("applyCustomerFacingCopy — exact-note-mismatch rejection", () => {
  it("rejects a response claiming a note the customer named but this combo doesn't have, and leaves the fallback untouched (no retry)", async () => {
    let fetchCalls = 0;
    global.fetch = vi.fn(async () => {
      fetchCalls++;
      return mockOkResponse({ description: "A blend built for apple lovers", whySuits: "Your love for apple shines through here." });
    });
    const item = makeItem({ missingExactNotes: ["apple"] });
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);

    expect(item.proposal.customerFacingDescription).toBe("FALLBACK_DESC");
    expect(item.proposal.customerFacingWhySuits).toBe("FALLBACK_WHY");
    expect(fetchCalls).toBe(1); // hard reject, not retried — same as the leak-guard
  });

  it("never flags legitimate copy that never mentions the missing note at all", async () => {
    global.fetch = vi.fn(async () => mockOkResponse({ description: "Bright citrus lift", whySuits: "Matches your love of fresh scents." }));
    const item = makeItem({ missingExactNotes: ["apple"] });
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);
    expect(item.proposal.customerFacingDescription).toBe("Bright citrus lift");
  });

  // Word-boundary matching (the same fix that stops Pineapple counting as Apple in scoring) applies
  // here too — legitimate copy about a genuinely-present Pineapple must never get caught by an
  // Apple-shaped guard just because "apple" is a substring of "pineapple".
  it("never false-positives on Pineapple when Apple is the missing term", async () => {
    global.fetch = vi.fn(async () => mockOkResponse({ description: "A pineapple-forward tropical blend", whySuits: "Bright and juicy." }));
    const item = makeItem({ missingExactNotes: ["apple"] });
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);
    expect(item.proposal.customerFacingDescription).toBe("A pineapple-forward tropical blend");
  });
});

describe("applyCustomerFacingCopy — 'never start with This' deterministic check", () => {
  it("detects a 'This ...' opener (checked in code, not left to the prompt), retries once, and accepts a clean retry", async () => {
    let callCount = 0;
    global.fetch = vi.fn(async (url, opts) => {
      callCount++;
      const body = JSON.parse(opts.body);
      const isRetry = body.messages[0].content.includes("RETRY");
      if (!isRetry) {
        return mockOkResponse({ description: "Rich vanilla warmth", whySuits: "This blend suits your sweet tooth perfectly." });
      }
      return mockOkResponse({ description: "Vanilla-forward and cozy", whySuits: "Your sweet tooth will love this blend." });
    });
    const item = makeItem();
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);

    expect(callCount).toBe(2); // initial + exactly one retry
    expect(item.proposal.customerFacingDescription).toBe("Vanilla-forward and cozy");
    expect(item.proposal.customerFacingWhySuits).toBe("Your sweet tooth will love this blend.");
  });

  it("falls back to the caller's existing values if the retry ALSO violates the rule", async () => {
    global.fetch = vi.fn(async () =>
      mockOkResponse({ description: "This one is lovely", whySuits: "This is perfect for you" }),
    );
    const item = makeItem();
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);

    expect(item.proposal.customerFacingDescription).toBe("FALLBACK_DESC");
    expect(item.proposal.customerFacingWhySuits).toBe("FALLBACK_WHY");
  });
});

describe("applyCustomerFacingCopy — fallback to the caller's existing values on any failure", () => {
  it("network error", async () => {
    global.fetch = vi.fn(async () => { throw new Error("network down"); });
    const item = makeItem();
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);
    expect(item.proposal.customerFacingDescription).toBe("FALLBACK_DESC");
  });

  it("timeout (AbortError)", async () => {
    global.fetch = vi.fn(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const item = makeItem();
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);
    expect(item.proposal.customerFacingDescription).toBe("FALLBACK_DESC");
  });

  it("non-ok HTTP response", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => "server error" }));
    const item = makeItem();
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);
    expect(item.proposal.customerFacingDescription).toBe("FALLBACK_DESC");
  });

  it("malformed JSON in the model's message content", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "not valid json {{{" } }] }) }));
    const item = makeItem();
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);
    expect(item.proposal.customerFacingDescription).toBe("FALLBACK_DESC");
  });

  it("empty field", async () => {
    global.fetch = vi.fn(async () => mockOkResponse({ description: "", whySuits: "Something real" }));
    const item = makeItem();
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);
    expect(item.proposal.customerFacingDescription).toBe("FALLBACK_DESC");
  });

  it("oversized field (over MAX_FIELD_LENGTH)", async () => {
    global.fetch = vi.fn(async () => mockOkResponse({ description: "x".repeat(300), whySuits: "Something real" }));
    const item = makeItem();
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);
    expect(item.proposal.customerFacingDescription).toBe("FALLBACK_DESC");
  });

  it("missing/non-string fields in an otherwise-valid JSON object", async () => {
    global.fetch = vi.fn(async () => mockOkResponse({ description: "Fine", whySuits: 12345 }));
    const item = makeItem();
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);
    expect(item.proposal.customerFacingDescription).toBe("FALLBACK_DESC");
  });
});

describe("applyCustomerFacingCopy — differentiated retry angles when 2+ items collide in the same wave", () => {
  it("assigns each retrying item a distinct angle from the OTHER items retrying alongside it", async () => {
    // Item A's initial response becomes the accepted baseline (first processed, nothing to
    // collide with yet). Items B and C both return the SAME description/whySuits as A on their
    // initial attempt, so both collide against A and both land in the same retry wave together.
    const itemA = makeItem({ customerFacingDescription: "FALLBACK_A", customerFacingWhySuits: "FALLBACK_WHY_A" });
    const itemB = makeItem({ customerFacingDescription: "FALLBACK_B", customerFacingWhySuits: "FALLBACK_WHY_B" });
    itemB.notesByRole = { Sweetness: ["Vanilla"] };
    const itemC = makeItem({ customerFacingDescription: "FALLBACK_C", customerFacingWhySuits: "FALLBACK_WHY_C" });
    itemC.notesByRole = { "Floral bridge": ["Jasmine"] };

    const retrySystemPrompts = [];
    global.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      const systemContent = body.messages[0].content;
      const isRetry = systemContent.includes("RETRY");
      if (!isRetry) {
        // All three collide on purpose.
        return mockOkResponse({ description: "Zesty citrus burst", whySuits: "Zesty and bright, just for you." });
      }
      retrySystemPrompts.push(systemContent);
      const userPayload = JSON.parse(body.messages[1].content);
      const notesJson = JSON.stringify(userPayload.notesByRole);
      if (notesJson.includes("Vanilla")) return mockOkResponse({ description: "Warm vanilla comfort", whySuits: "Built around your cozy side." });
      return mockOkResponse({ description: "Delicate floral lift", whySuits: "A gentle match for your taste." });
    });

    await applyCustomerFacingCopy([itemA, itemB, itemC], PROFILE_FIELDS, []);

    // A was accepted as-is from wave 1 (first processed, nothing to collide with).
    expect(itemA.proposal.customerFacingDescription).toBe("Zesty citrus burst");
    // B and C both had to retry.
    expect(retrySystemPrompts.length).toBe(2);
    // Their assigned angles must differ from EACH OTHER, not just both avoid A's opening.
    const angleOf = (prompt) => prompt.match(/use this distinct angle: (.+)/)?.[1];
    const angleB = angleOf(retrySystemPrompts[0]);
    const angleC = angleOf(retrySystemPrompts[1]);
    expect(angleB).toBeTruthy();
    expect(angleC).toBeTruthy();
    expect(angleB).not.toBe(angleC);
    // And both retries succeeded with genuinely different, non-colliding output.
    expect(itemB.proposal.customerFacingDescription).toBe("Warm vanilla comfort");
    expect(itemC.proposal.customerFacingDescription).toBe("Delicate floral lift");
  });
});

describe("applyCustomerFacingCopy — happy path", () => {
  it("applies a valid, distinct, non-violating response directly with no retry", async () => {
    global.fetch = vi.fn(async () => mockOkResponse({ description: "Bright citrus lift", whySuits: "Matches your love of fresh scents." }));
    const item = makeItem();
    await applyCustomerFacingCopy([item], PROFILE_FIELDS, []);
    expect(item.proposal.customerFacingDescription).toBe("Bright citrus lift");
    expect(item.proposal.customerFacingWhySuits).toBe("Matches your love of fresh scents.");
  });

  it("does nothing on an empty item list", async () => {
    global.fetch = vi.fn();
    await applyCustomerFacingCopy([], PROFILE_FIELDS, []);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
