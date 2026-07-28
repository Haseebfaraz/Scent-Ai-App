// scripts/import-hybrid-catalog.cjs
//
// Imports data/Notes-Extraction-Separated-hybird.xlsx into FragranceProduct and
// ExistingCombination:
//   - "Notes-Extraction-Separated" sheet -> FragranceProduct (every real DUA product, all
//     Collection types: Inspiration, Dua Original, Hybrid, Tribrid, Quadbrid, Original — this
//     sheet already carries notes/price/collection for every product, combinations included).
//   - "Inspirations" sheet -> enriches existing FragranceProduct rows with tagLine/
//     inspirationName/inspirationBrand/isSingleInspiration. Matched onto a row the base-catalog
//     import already created (by normalized title, falling back to handle) — this sheet never
//     creates a new product, only annotates one that already exists. A row that matches neither is
//     logged and left alone rather than guessed at. A row whose metadata already matches what's
//     stored is skipped (not re-written), and counted separately, so re-running this script is a
//     genuine no-op against unchanged source data.
//   - "Hybrid" / "Tribrid" / "Quadbrid" sheets -> ExistingCombination, one row per named
//     combination product, linking it to the real component product titles it's built from.
//
// All three imports write via batched multi-row raw SQL (INSERT/UPDATE ... ON CONFLICT or a
// VALUES-join), not one Prisma call per row inside a loop — an earlier version of the sibling
// script scripts/build-region-summary.cjs did the latter (one upsert() per row) and Render's
// Postgres closed the connection partway through a 32k-row batch (P1017), almost certainly from
// holding hundreds of individual round trips open too long. The same fix applies here: every
// write is a single statement per BATCH_SIZE-row chunk.
//
// Run with: node scripts/import-hybrid-catalog.cjs

const crypto = require('crypto');
const path = require('path');
const XLSX = require('xlsx');
const { PrismaClient, Prisma } = require('@prisma/client');

const prisma = new PrismaClient();
const BATCH_SIZE = 500;

async function loadEsmHelpers() {
  const { normalizeProductName } = await import('../app/utils/fragranceNormalization.js');
  const { createCombinationKey } = await import('../app/utils/combinationKey.js');
  return { normalizeProductName, createCombinationKey };
}

// Each combination sheet has a merged category-title row (row 0) above the real header row
// (row 1), so header:1 + slicing off the first two rows is used instead of the default
// object-per-row parse (which would otherwise treat row 0 as the header).
function readSheetRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return null;
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
}

// Sheets/Hybrid,Tribrid,Quadbrid all share the same layout after the header:
//   col0 Handle, col1 Title, col2 Tag Line, then N groups of 3 columns
//   (Inspiration, Dua Inspiration Name, Brand) — one group per component.
// Quadbrid's group-2 "Dua Inspiration Name" header cell is mislabeled "Handle" in the source
// file, so components are read BY POSITION, never by header text, sidestepping that bug entirely.
const COMBINATION_SHEETS = [
  { sheet: 'Hybrid', type: 'HYBRID', componentCount: 2 },
  { sheet: 'Tribrid', type: 'TRIBRID', componentCount: 3 },
  { sheet: 'Quadbrid', type: 'QUADBRID', componentCount: 4 },
];

async function importBaseCatalog(workbook, normalizeProductName) {
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Notes-Extraction-Separated'], { defval: null });
  const skipped = [];
  const validRows = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const handle = typeof row.Handle === 'string' ? row.Handle.trim() : String(row.Handle ?? '').trim();
    const title = typeof row.Title === 'string' ? row.Title.trim() : null;

    if (!title) {
      skipped.push({ rowNumber: i + 2, reason: 'Title is missing or not text', row });
      continue;
    }

    const normalizedTitle = normalizeProductName(title);
    const notesRaw = (row.Notes || '').trim() || null;
    const notesJson = notesRaw ? notesRaw.split(',').map((n) => n.trim()).filter(Boolean) : [];

    validRows.push({
      handle: handle || null,
      title,
      normalizedTitle,
      notesRaw,
      notesJson,
      collection: row.Collection || null,
      pricePer5ml: typeof row.PricePer5ml === 'number' ? row.PricePer5ml : null,
    });
  }

  // Same defensive dedup as importCombinationSheet below — Stage A verification confirmed this
  // sheet currently has zero duplicate normalizedTitle rows, but a single batched INSERT ... ON
  // CONFLICT would crash outright if a future edit to the source file ever introduced one.
  const dedupedRows = [...new Map(validRows.map((r) => [r.normalizedTitle, r])).values()];

  for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
    const batch = dedupedRows.slice(i, i + BATCH_SIZE);
    const values = batch.map(
      (r) => Prisma.sql`(${crypto.randomUUID()}, ${r.handle}, ${r.title}, ${r.normalizedTitle}, ${r.notesRaw}, ${JSON.stringify(r.notesJson)}::jsonb, ${r.collection}, ${r.pricePer5ml}, now(), now())`,
    );
    await prisma.$executeRaw`
      INSERT INTO "FragranceProduct"
        (id, handle, title, "normalizedTitle", "notesRaw", "notesJson", collection, "pricePer5ml", "createdAt", "updatedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("normalizedTitle") DO UPDATE SET
        handle = EXCLUDED.handle,
        title = EXCLUDED.title,
        "notesRaw" = EXCLUDED."notesRaw",
        "notesJson" = EXCLUDED."notesJson",
        collection = EXCLUDED.collection,
        "pricePer5ml" = EXCLUDED."pricePer5ml",
        "updatedAt" = now()
    `;
  }

  return { imported: dedupedRows.length, skipped };
}

// "Inspirations" shares the same merged-category-title-row-then-header layout as the combination
// sheets (see readSheetRows), with columns: Handle, Title, Tag Line, Inspiration (original perfume
// name), Brand. Matches onto an EXISTING FragranceProduct row (created by importBaseCatalog above)
// by normalized title first, falling back to handle for the small number of rows where the title
// text differs slightly between sheets but the handle still agrees — never creates a new product.
// A row whose target metadata is already identical to what's stored is left untouched (tracked
// separately as `alreadyIdentical`), so a second run against unchanged source data writes nothing.
async function importInspirations(workbook, normalizeProductName) {
  const dataRows = readSheetRows(workbook, 'Inspirations')?.slice(2);
  if (!dataRows) {
    return {
      imported: 0, skipped: [{ reason: 'Sheet "Inspirations" not found' }],
      totalRows: 0, matchedByTitle: 0, matchedByHandle: 0, alreadyIdentical: 0,
    };
  }

  const products = await prisma.fragranceProduct.findMany({
    select: {
      id: true, normalizedTitle: true, handle: true,
      tagLine: true, inspirationName: true, inspirationBrand: true, isSingleInspiration: true,
    },
  });
  const byNormalizedTitle = new Map(products.map((p) => [p.normalizedTitle, p]));
  const byHandle = new Map(products.filter((p) => p.handle).map((p) => [p.handle, p]));

  const skipped = [];
  const toUpdate = [];
  let totalRows = 0;
  let matchedByTitle = 0;
  let matchedByHandle = 0;
  let alreadyIdentical = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const cols = dataRows[i];
    const excelRowNumber = i + 3;
    const handle = typeof cols[0] === 'string' ? cols[0].trim() : null;
    const title = typeof cols[1] === 'string' ? cols[1].trim() : null;
    const tagLine = typeof cols[2] === 'string' ? cols[2].trim() : null;
    const inspirationName = typeof cols[3] === 'string' ? cols[3].trim() : null;
    const inspirationBrand = typeof cols[4] === 'string' ? cols[4].trim() : null;

    if (!title) {
      skipped.push({ sheet: 'Inspirations', rowNumber: excelRowNumber, reason: 'Title (col B) is missing or not text' });
      continue;
    }
    totalRows++;

    const normalizedTitle = normalizeProductName(title);
    let match = byNormalizedTitle.get(normalizedTitle);
    if (match) {
      matchedByTitle++;
    } else if (handle && byHandle.has(handle)) {
      match = byHandle.get(handle);
      matchedByHandle++;
    }

    if (!match) {
      skipped.push({
        sheet: 'Inspirations',
        rowNumber: excelRowNumber,
        title,
        handle,
        reason: 'No matching FragranceProduct found by normalized title or handle — not guessed, not created',
      });
      continue;
    }

    const isIdentical =
      match.tagLine === tagLine &&
      match.inspirationName === inspirationName &&
      match.inspirationBrand === inspirationBrand &&
      match.isSingleInspiration === true;
    if (isIdentical) {
      alreadyIdentical++;
      continue;
    }

    toUpdate.push({ id: match.id, tagLine, inspirationName, inspirationBrand });
  }

  for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
    const batch = toUpdate.slice(i, i + BATCH_SIZE);
    const values = batch.map(
      (r) => Prisma.sql`(${r.id}::text, ${r.tagLine}, ${r.inspirationName}, ${r.inspirationBrand})`,
    );
    await prisma.$executeRaw`
      UPDATE "FragranceProduct" AS f SET
        "tagLine" = v.tag_line,
        "inspirationName" = v.inspiration_name,
        "inspirationBrand" = v.inspiration_brand,
        "isSingleInspiration" = true,
        "updatedAt" = now()
      FROM (VALUES ${Prisma.join(values)}) AS v(id, tag_line, inspiration_name, inspiration_brand)
      WHERE f.id = v.id
    `;
  }

  return { imported: toUpdate.length, skipped, totalRows, matchedByTitle, matchedByHandle, alreadyIdentical };
}

async function importCombinationSheet(workbook, def, helpers, productTitleIndex, existingComponentKeys) {
  const { normalizeProductName, createCombinationKey } = helpers;
  const rawRows = readSheetRows(workbook, def.sheet);
  if (!rawRows) {
    return { imported: 0, skipped: [{ reason: `Sheet "${def.sheet}" not found` }] };
  }

  // rawRows[0] = merged category title, rawRows[1] = real header, data starts at rawRows[2].
  const dataRows = rawRows.slice(2);
  const skipped = [];
  const validRows = [];

  for (let i = 0; i < dataRows.length; i++) {
    const cols = dataRows[i];
    const excelRowNumber = i + 3; // 1-indexed, matching what a human sees in Excel
    const title = typeof cols[1] === 'string' ? cols[1].trim() : null;
    const tagLine = typeof cols[2] === 'string' ? cols[2].trim() : null;

    if (!title) {
      skipped.push({ sheet: def.sheet, rowNumber: excelRowNumber, reason: 'Title (col B) is missing or not text' });
      continue;
    }

    const componentTitles = [];
    let missingComponent = false;
    for (let g = 0; g < def.componentCount; g++) {
      const duaNameCol = 3 + g * 3 + 1; // Inspiration, [Dua Inspiration Name], Brand per group
      const rawName = cols[duaNameCol];
      const componentTitle = typeof rawName === 'string' ? rawName.trim() : null;
      if (!componentTitle) {
        missingComponent = true;
        break;
      }
      componentTitles.push(componentTitle);
    }

    if (missingComponent) {
      skipped.push({
        sheet: def.sheet,
        rowNumber: excelRowNumber,
        title,
        reason: `Expected ${def.componentCount} "Dua Inspiration Name" values, found a blank one`,
      });
      continue;
    }

    const unresolvedComponents = componentTitles.filter(
      (t) => !productTitleIndex.has(normalizeProductName(t)),
    );
    if (unresolvedComponents.length) {
      skipped.push({
        sheet: def.sheet,
        rowNumber: excelRowNumber,
        title,
        reason: 'Component name(s) not found in FragranceProduct catalog',
        unresolvedComponents,
      });
      // Not skipped from import — these are real names from the source file, just not
      // cross-referenced in the base catalog sheet. Logged so verification can review.
    }

    const componentKey = createCombinationKey(componentTitles);
    const normalizedTitle = normalizeProductName(title);

    const existingTitle = existingComponentKeys.get(componentKey);
    if (existingTitle !== undefined && existingTitle !== normalizedTitle) {
      skipped.push({
        sheet: def.sheet,
        rowNumber: excelRowNumber,
        title,
        reason: `componentKey collision — same component set already imported under a different title`,
        componentKey,
      });
      continue;
    }

    validRows.push({ title, normalizedTitle, componentProductsJson: componentTitles, componentKey, tagLine });
    // Reserve the key immediately so a later row in the SAME sheet with an identical component
    // set (but a different title) is also caught as a collision, not silently upserted twice.
    existingComponentKeys.set(componentKey, normalizedTitle);
  }

  // A single multi-row `INSERT ... ON CONFLICT DO UPDATE` cannot target the same conflict key
  // twice within one statement (Postgres: "ON CONFLICT DO UPDATE command cannot affect row a
  // second time") — verified against real data that the Tribrid sheet contains one literal
  // duplicate row ("Poseidon's Ottoman Supernova" appears twice with the same components), which
  // the per-row collision check above correctly does NOT flag (same title, not a collision) but
  // would still crash a batched upsert. Deduping by componentKey here (keeping the last
  // occurrence — the same row a sequential upsert would have ended up applying last) makes the
  // batch safe without changing which data wins.
  const dedupedRows = [...new Map(validRows.map((r) => [r.componentKey, r])).values()];

  for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
    const batch = dedupedRows.slice(i, i + BATCH_SIZE);
    const values = batch.map(
      (r) => Prisma.sql`(${crypto.randomUUID()}, ${r.title}, ${r.normalizedTitle}, ${def.type}, ${JSON.stringify(r.componentProductsJson)}::jsonb, ${r.componentKey}, ${r.tagLine}, now())`,
    );
    await prisma.$executeRaw`
      INSERT INTO "ExistingCombination"
        (id, title, "normalizedTitle", type, "componentProductsJson", "componentKey", "tagLine", "createdAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("componentKey") DO UPDATE SET
        title = EXCLUDED.title,
        "normalizedTitle" = EXCLUDED."normalizedTitle",
        type = EXCLUDED.type,
        "componentProductsJson" = EXCLUDED."componentProductsJson",
        "tagLine" = EXCLUDED."tagLine"
    `;
  }

  return { imported: dedupedRows.length, skipped };
}

async function main() {
  const { normalizeProductName, createCombinationKey } = await loadEsmHelpers();

  const filePath = path.join(__dirname, '..', 'data', 'Notes-Extraction-Separated-hybird.xlsx');
  const workbook = XLSX.readFile(filePath);

  console.log('Importing base catalog (FragranceProduct) from "Notes-Extraction-Separated"...');
  const baseResult = await importBaseCatalog(workbook, normalizeProductName);
  console.log(`  Imported ${baseResult.imported} products.`);
  if (baseResult.skipped.length) {
    console.log(`  Skipped ${baseResult.skipped.length} row(s):`);
    for (const s of baseResult.skipped) {
      console.log(`    - row ${s.rowNumber}: ${s.reason}`);
    }
  }

  console.log('\nImporting Inspirations metadata (tagLine/inspirationName/inspirationBrand)...');
  const inspResult = await importInspirations(workbook, normalizeProductName);
  console.log(`  ${inspResult.totalRows} real rows read; matched ${inspResult.matchedByTitle} by title, ${inspResult.matchedByHandle} by handle; ${inspResult.alreadyIdentical} already identical (skipped); ${inspResult.imported} updated.`);
  if (inspResult.skipped.length) {
    console.log(`  Flagged ${inspResult.skipped.length} row(s):`);
    for (const s of inspResult.skipped) {
      console.log(`    - row ${s.rowNumber} ("${s.title ?? ''}"): ${s.reason}`);
    }
  }

  const productTitleIndex = new Set(
    (await prisma.fragranceProduct.findMany({ select: { normalizedTitle: true } })).map(
      (p) => p.normalizedTitle,
    ),
  );
  const existingComponentKeys = new Map(
    (await prisma.existingCombination.findMany({ select: { componentKey: true, normalizedTitle: true } })).map(
      (c) => [c.componentKey, c.normalizedTitle],
    ),
  );

  for (const def of COMBINATION_SHEETS) {
    console.log(`\nImporting ${def.type} combinations from "${def.sheet}"...`);
    const result = await importCombinationSheet(
      workbook,
      def,
      { normalizeProductName, createCombinationKey },
      productTitleIndex,
      existingComponentKeys,
    );
    console.log(`  Imported ${result.imported} combinations.`);
    if (result.skipped.length) {
      console.log(`  Flagged ${result.skipped.length} row(s):`);
      for (const s of result.skipped) {
        console.log(`    - row ${s.rowNumber} ("${s.title ?? ''}"): ${s.reason}${
          s.unresolvedComponents ? ` [${s.unresolvedComponents.join(', ')}]` : ''
        }`);
      }
    }
  }

  console.log('\nDone.');
}

// Only auto-run the full import when executed directly (`node scripts/import-hybrid-catalog.cjs`)
// — requiring this file from a test (to reuse importInspirations against a synthetic workbook)
// must NOT also re-import the entire real catalog into production every time the test loads.
if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

module.exports = { importInspirations };
