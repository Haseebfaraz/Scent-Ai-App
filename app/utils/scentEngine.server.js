import { parse } from "csv-parse/sync";
import fs from "fs";
import path from "path";
import Fuse from "fuse.js";

// data/Notes-Extraction-Separated.csv has no per-note Layer/Category/Description columns — each
// row is one whole sellable container (Handle, Title, Notes, PricePer5ml), so fuzzy search runs
// over the real columns (Title, Notes), and layer assignment below uses a keyword heuristic since
// the source data has no ground truth for which individual note is top/middle/base.
let CONTAINERS = [];
let LOAD_ERROR = null;
try {
  const csvPath = path.join(process.cwd(), "data", "Notes-Extraction-Separated.csv");
  const fileContent = fs.readFileSync(csvPath, "utf-8");
  CONTAINERS = parse(fileContent, { columns: true, skip_empty_lines: true, trim: true });
} catch (err) {
  LOAD_ERROR = err.message;
  console.error("[scentEngine] Failed to load catalog:", err.message);
}

// threshold 0.4 (as requested) — tolerant enough to catch real typos (e.g. "sandlewood") without
// matching so loosely that unrelated notes start showing up.
const fuse = new Fuse(CONTAINERS, { keys: ["Title", "Notes"], threshold: 0.4, ignoreLocation: true });

// Standard perfumery convention, used only to guess a note's likely layer since the catalog
// itself doesn't classify one — light/volatile notes read as "top", heavy/anchoring ones as
// "base", everything else defaults to "middle".
const TOP_NOTE_KEYWORDS = ["citrus", "bergamot", "lemon", "lime", "mandarin", "orange", "grapefruit", "green tea", "mint", "lavender", "pink pepper", "blackcurrant", "aldehyde"];
const BASE_NOTE_KEYWORDS = ["musk", "amber", "vanilla", "sandalwood", "cedar", "oud", "leather", "patchouli", "vetiver", "ambergris", "tonka", "moss"];

function classifyNote(note) {
  const lower = note.toLowerCase();
  if (TOP_NOTE_KEYWORDS.some(k => lower.includes(k))) return "top";
  if (BASE_NOTE_KEYWORDS.some(k => lower.includes(k))) return "base";
  return "middle";
}

function realNotesOf(container) {
  return (container.Notes || "").split(",").map(n => n.trim()).filter(Boolean);
}

// Which layer a container's own note list leans toward overall — used to decide which real
// container becomes THE container for each layer position below.
function dominantLayer(container) {
  const tally = { top: 0, middle: 0, base: 0 };
  for (const note of realNotesOf(container)) tally[classifyNote(note)]++;
  return Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
}

// Deterministically builds a real, 3-container blend (one container per layer — same convention
// confirm_scent_combination already requires) and returns up to 3 real notes to display per
// layer. Every note and internal_id here traces back to an actual catalog row — never invented.
// coOccurringNotes/regionalNotes are real note-name arrays the caller already looked up from
// order_history (this module stays DB-free, so it's easy to reason about and test on its own).
export function generate3x3Pyramid({ vibe = "", coOccurringNotes = [], regionalNotes = [] }) {
  if (LOAD_ERROR || CONTAINERS.length === 0) {
    return { top: null, middle: null, base: null, containers: [], error: LOAD_ERROR || "Catalog not loaded" };
  }

  const fuzzyMatches = vibe ? fuse.search(vibe).map(r => r.item) : [];
  const pool = fuzzyMatches.length > 0 ? fuzzyMatches : CONTAINERS;

  const coLower = coOccurringNotes.map(n => n.toLowerCase());
  const regionLower = regionalNotes.map(n => n.toLowerCase());
  const bonus = (c) => {
    const notesLower = (c.Notes || "").toLowerCase();
    return coLower.filter(n => notesLower.includes(n)).length + regionLower.filter(n => notesLower.includes(n)).length;
  };
  const ranked = [...pool].sort((a, b) => bonus(b) - bonus(a));

  // Bucket ranked candidates by their dominant layer, then take the best-ranked candidate in
  // each bucket. If a bucket is empty, fall back to the next-best unused candidate overall —
  // guarantees all 3 layers get filled whenever the catalog has at least 3 usable rows.
  const buckets = { top: [], middle: [], base: [] };
  for (const c of ranked) buckets[dominantLayer(c)].push(c);

  const used = new Set();
  const pick = (layer) => {
    const fromBucket = buckets[layer].find(c => !used.has(c.Title));
    const fallback = fromBucket || ranked.find(c => !used.has(c.Title));
    if (fallback) used.add(fallback.Title);
    return fallback || null;
  };

  const assignment = { top: pick("top"), middle: pick("middle"), base: pick("base") };
  const result = { top: null, middle: null, base: null, containers: [], error: null };

  for (const layer of ["top", "middle", "base"]) {
    const container = assignment[layer];
    if (!container) continue;
    const notes = realNotesOf(container);
    // Prefer notes that actually match this layer's character when the container has more than
    // 3, so e.g. a base container's citrus top-note (if it has one) doesn't crowd out its own
    // heavier notes — but never invent to pad past what's genuinely there.
    const preferred = notes.filter(n => classifyNote(n) === layer);
    const chosen = (preferred.length > 0 ? preferred : notes).slice(0, 3);
    result[layer] = { notes: chosen, internal_id: container.Title };
    result.containers.push({ internal_id: container.Title, position: layer });
  }

  return result;
}
