import { describe, it, expect } from "vitest";
import { assignNotePositions } from "./notePositionMapping.js";

describe("assignNotePositions", () => {
  it("classifies the spec's own worked example correctly", () => {
    const notes = ["Bergamot", "Mandarin", "Sea Salt", "Green Tea", "Pear", "Sage", "Ambrette", "Musk", "Sandalwood", "Benzoin"];
    const result = assignNotePositions(notes);
    expect(result.top).toEqual(expect.arrayContaining(["Bergamot", "Mandarin", "Sea Salt"]));
    expect(result.middle).toEqual(expect.arrayContaining(["Green Tea", "Pear", "Sage"]));
    expect(result.base).toEqual(expect.arrayContaining(["Musk", "Sandalwood", "Benzoin"]));
  });

  it("never invents a note — every returned note is one of the real inputs, spelled exactly the same", () => {
    const notes = ["Bergamot", "Cardamom", "Patchouli", "Guaiac Wood", "Vanilla"];
    const result = assignNotePositions(notes);
    const allReturned = [...result.top, ...result.middle, ...result.base];
    for (const returned of allReturned) {
      expect(notes).toContain(returned);
    }
  });

  it("never duplicates a note across or within a bucket", () => {
    const notes = ["Bergamot", "Bergamot", "Musk", "Vanilla", "Musk"];
    const result = assignNotePositions(notes);
    const allReturned = [...result.top, ...result.middle, ...result.base];
    expect(new Set(allReturned.map((n) => n.toLowerCase())).size).toBe(allReturned.length);
  });

  it("caps every bucket at 5 notes", () => {
    const manyTop = Array.from({ length: 10 }, (_, i) => `Citrus Note ${i}`);
    const result = assignNotePositions(manyTop);
    expect(result.top.length).toBeLessThanOrEqual(5);
  });

  it("tops up a thin bucket to 3 when enough real notes exist overall, borrowing rather than inventing", () => {
    // Every note here is a real "top" note except one lone base note.
    const notes = ["Bergamot", "Lemon", "Lime", "Mandarin", "Orange", "Grapefruit", "Musk"];
    const result = assignNotePositions(notes);
    expect(result.base.length).toBeGreaterThanOrEqual(1);
    const allReturned = [...result.top, ...result.middle, ...result.base];
    for (const returned of allReturned) {
      expect(notes).toContain(returned);
    }
  });

  it("classifies an unrecognized note into 'middle' as the documented default, never dropping it", () => {
    const result = assignNotePositions(["Zzznotarealnoteatall"]);
    expect(result.middle).toContain("Zzznotarealnoteatall");
  });

  // Fix (customer's own liked notes silently dropped from display) — a middle bucket over the
  // 5-note cap used to keep whichever 5 arrived first, with zero regard for stated likes. Confirmed
  // live: "Apple" (a real fruity note in the actual combination) lost its slot to unrelated
  // default-bucketed notes that merely appeared earlier in the raw note list.
  it("keeps a customer's liked notes over unrelated ones when a bucket exceeds the 5-note cap", () => {
    const notes = ["Lily of the Valley", "Ambrette", "Freesia", "Geranium", "Osmanthus", "Apple"];
    const withoutLikes = assignNotePositions(notes);
    expect(withoutLikes.middle).not.toContain("Apple");

    const withLikes = assignNotePositions(notes, ["fruity"]);
    expect(withLikes.middle).toContain("Apple");
  });
});
