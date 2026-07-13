// app/fragrance-data.js
//
// Everything needed to ground Claude's answers in your actual note
// catalog and order history, instead of it inventing fragrance
// knowledge from general training data.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Pull every distinct family your notes table actually has.
 * Used both for keyword-matching the customer's message and for
 * sanity-checking that we're only ever working with real families.
 */
export async function getAllFamilies() {
  const rows = await prisma.note.findMany({
    where: { family: { not: null } },
    select: { family: true },
    distinct: ['family'],
  });
  return rows.map((r) => r.family).filter(Boolean);
}

/**
 * Very simple keyword match: does the customer's message mention
 * any known family by name? No extra AI call needed for this MVP —
 * it's a plain substring check against families that actually exist
 * in your data.
 */
export function extractMentionedFamilies(message, allFamilies) {
  const lower = message.toLowerCase();
  return allFamilies.filter((family) => lower.includes(family.toLowerCase()));
}

/**
 * Get the actual notes to ground Claude's recommendation in.
 * If the customer has mentioned specific families, filter to those.
 * Otherwise fall back to the highest-density notes across the board,
 * so there's always something reasonable to work with.
 */
export async function getRelevantNotes(mentionedFamilies, limit = 40) {
  const where =
    mentionedFamilies.length > 0 ? { family: { in: mentionedFamilies } } : {};

  const notes = await prisma.note.findMany({
    where,
    orderBy: { density: 'desc' },
    take: limit,
  });

  return notes;
}

/**
 * Look at past orders in the matched families and tally which notes
 * came up together most often — this is the "customers with similar
 * preferences tended toward..." signal, built from plain aggregation,
 * no machine learning involved.
 */
export async function getPopularPairings(mentionedFamilies, limit = 8) {
  if (mentionedFamilies.length === 0) return [];

  const orders = await prisma.orderHistory.findMany({
    where: { classification: { in: mentionedFamilies } },
    select: { notes: true },
    take: 5000, // cap the scan for performance on a ~937k row table
  });

  const tally = {};
  for (const order of orders) {
    const notes = order.notes.split(',').map((n) => n.trim()).filter(Boolean);
    for (const note of notes) {
      tally[note] = (tally[note] || 0) + 1;
    }
  }

  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

/**
 * Group notes by their dominant position, for a clean readable list
 * in the prompt (top / middle / base).
 */
function groupByPosition(notes) {
  const groups = { top: [], middle: [], base: [] };
  for (const note of notes) {
    if (groups[note.position]) {
      groups[note.position].push(note.name);
    }
  }
  return groups;
}

/**
 * The main function to call before every Claude request: builds a
 * system prompt grounded in real notes and real historical pairings,
 * based on whatever the customer has said so far.
 */
export async function buildFragranceSystemPrompt(latestMessage) {
  const allFamilies = await getAllFamilies();
  const mentionedFamilies = extractMentionedFamilies(latestMessage, allFamilies);

  const notes = await getRelevantNotes(mentionedFamilies);
  const pairings = await getPopularPairings(mentionedFamilies);
  const grouped = groupByPosition(notes);

  const pairingLine =
    pairings.length > 0
      ? `Customers with similar preferences have often chosen: ${pairings
          .map((p) => p.name)
          .join(', ')}.`
      : '';

  return `You are a fragrance advisor for a custom perfume store. You ONLY discuss scent preferences and fragrance recommendations — politely redirect any unrelated questions back to fragrance.

Ask about the customer's preferences (mood, occasion, intensity, favorite scent families, notes to avoid) before recommending anything. Keep questions to one at a time.

You may ONLY recommend notes from this list — never invent a note that isn't here:
Top notes: ${grouped.top.join(', ') || 'none matched yet'}
Middle notes: ${grouped.middle.join(', ') || 'none matched yet'}
Base notes: ${grouped.base.join(', ') || 'none matched yet'}

${pairingLine}

Once you have enough information and are ready to propose a recipe, respond with a short explanation followed by exactly this format on its own line:
[RECIPE_READY]{"top":["Note Name"],"middle":["Note Name"],"base":["Note Name"]}

Do not use this format until you're actually ready to propose a finished recipe.`;
}
