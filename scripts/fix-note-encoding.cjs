// scripts/fix-note-encoding.cjs
//
// One-off migration: corrects the 92 FragranceProduct rows whose notesRaw/notesJson already
// contain the "ï¿½" mojibake artifact (see scripts/noteEncodingFixes.cjs for the full root-cause
// explanation and the correction map). Only touches rows that actually contain the corruption
// marker; every other row is left untouched. notesJson is re-derived from the corrected notesRaw
// using the exact same split/trim logic scripts/import-hybrid-catalog.cjs uses, so the two stay
// consistent with each other exactly as they were at import time.
//
// Run with: node scripts/fix-note-encoding.cjs
const { PrismaClient, Prisma } = require("@prisma/client");
const { fixNoteEncoding } = require("./noteEncodingFixes.cjs");

const prisma = new PrismaClient();
const BATCH_SIZE = 500;

async function main() {
  const rows = await prisma.fragranceProduct.findMany({
    where: { notesRaw: { contains: "ï¿½" } },
    select: { id: true, title: true, notesRaw: true },
  });
  console.log(`Found ${rows.length} row(s) with corrupted notesRaw.`);

  const updates = [];
  const stillCorrupted = [];
  for (const row of rows) {
    const notesRaw = fixNoteEncoding(row.notesRaw);
    if (notesRaw.includes("ï¿½")) {
      stillCorrupted.push(row.title);
      continue;
    }
    const notesJson = notesRaw.split(",").map((n) => n.trim()).filter(Boolean);
    updates.push({ id: row.id, notesRaw, notesJson });
  }

  if (stillCorrupted.length) {
    console.log(`WARNING: ${stillCorrupted.length} row(s) have a corruption pattern not in the correction map — left untouched:`);
    stillCorrupted.forEach((t) => console.log(`  - ${t}`));
  }

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    const values = batch.map(
      (r) => Prisma.sql`(${r.id}::text, ${r.notesRaw}, ${JSON.stringify(r.notesJson)}::jsonb)`,
    );
    await prisma.$executeRaw`
      UPDATE "FragranceProduct" AS f SET
        "notesRaw" = v.notes_raw,
        "notesJson" = v.notes_json,
        "updatedAt" = now()
      FROM (VALUES ${Prisma.join(values)}) AS v(id, notes_raw, notes_json)
      WHERE f.id = v.id
    `;
  }

  console.log(`Corrected ${updates.length} row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
