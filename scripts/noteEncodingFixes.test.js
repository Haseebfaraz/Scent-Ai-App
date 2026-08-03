// Regression test for the note-encoding correction map — see noteEncodingFixes.cjs for the full
// root-cause explanation (the source catalog spreadsheet already contains "ï¿½" mojibake for every
// accented letter/apostrophe/trademark symbol before this codebase ever touched the data).
import { describe, it, expect } from "vitest";
import { fixNoteEncoding, CORRECTIONS } from "./noteEncodingFixes.cjs";

describe("fixNoteEncoding", () => {
  it("leaves clean text untouched", () => {
    expect(fixNoteEncoding("Bergamot, Musk, Vanilla")).toBe("Bergamot, Musk, Vanilla");
    expect(fixNoteEncoding(null)).toBe(null);
    expect(fixNoteEncoding(undefined)).toBe(undefined);
  });

  it("corrects a known corrupted note inside a real comma-joined notesRaw string", () => {
    const notesRaw = "Lime Juice, Strawberry Purï¿½e, Strawberry Syrup, Whipped Cream, White Rum, White Musk";
    expect(fixNoteEncoding(notesRaw)).toBe(
      "Lime Juice, Strawberry Purée, Strawberry Syrup, Whipped Cream, White Rum, White Musk",
    );
  });

  // Fix (substring-collision safety) — "Matï¿½" is itself a substring of the longer, more specific
  // "Green Matï¿½ Absolute" entry; replacing the short one first would make the long one
  // un-matchable afterward. Confirms the longest-key-first ordering actually works end to end.
  it("resolves every entry in the correction map to clean text with no leftover corruption", () => {
    for (const [bad, good] of Object.entries(CORRECTIONS)) {
      expect(fixNoteEncoding(bad)).toBe(good);
      expect(fixNoteEncoding(bad)).not.toContain("ï¿½");
    }
  });

  it("corrects multiple different corrupted notes in the same string", () => {
    const notesRaw = "Matï¿½, Vanilla Crï¿½me, Musk";
    expect(fixNoteEncoding(notesRaw)).toBe("Maté, Vanilla Crème, Musk");
  });
});
