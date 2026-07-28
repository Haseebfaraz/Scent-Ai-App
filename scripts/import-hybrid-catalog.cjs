// scripts/import-hybrid-catalog.cjs
//
// Imports data/Notes-Extraction-Separated-hybird.xlsx into FragranceProduct and
// ExistingCombination:
//   - "Notes-Extraction-Separated" sheet -> FragranceProduct (every real DUA product, all
//     Collection types: Inspiration, Dua Original, Hybrid, Tribrid, Quadbrid, Original — this
//     sheet already carries notes/price/collection for every product, combinations included).
//   - "Hybrid" / "Tribrid" / "Quadbrid" sheets -> ExistingCombination, one row per named
//     combination product, linking it to the real component product titles it's built from.
//
// The "Inspirations" sheet is NOT imported as a combination — it's single-inspiration metadata
// (tag line / original perfume name / brand) for products already captured via
// "Notes-Extraction-Separated"; it carries no combination structure.
//
// Run with: node scripts/import-hybrid-catalog.cjs

const path = require('path');
const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

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
  let imported = 0;
  const skipped = [];

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
    const notesJson = notesRaw
      ? notesRaw.split(',').map((n) => n.trim()).filter(Boolean)
      : [];

    await prisma.fragranceProduct.upsert({
      where: { normalizedTitle },
      update: {
        handle: handle || null,
        title,
        notesRaw,
        notesJson,
        collection: row.Collection || null,
        pricePer5ml: typeof row.PricePer5ml === 'number' ? row.PricePer5ml : null,
      },
      create: {
        handle: handle || null,
        title,
        normalizedTitle,
        notesRaw,
        notesJson,
        collection: row.Collection || null,
        pricePer5ml: typeof row.PricePer5ml === 'number' ? row.PricePer5ml : null,
      },
    });
    imported++;
  }

  return { imported, skipped };
}

async function importCombinationSheet(workbook, def, helpers, productTitleIndex) {
  const { normalizeProductName, createCombinationKey } = helpers;
  const rawRows = readSheetRows(workbook, def.sheet);
  if (!rawRows) {
    return { imported: 0, skipped: [{ reason: `Sheet "${def.sheet}" not found` }] };
  }

  // rawRows[0] = merged category title, rawRows[1] = real header, data starts at rawRows[2].
  const dataRows = rawRows.slice(2);
  let imported = 0;
  const skipped = [];

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
      // cross-referenced in the base catalog sheet. Logged so Task #4 verification can review.
    }

    const componentKey = createCombinationKey(componentTitles);
    const normalizedTitle = normalizeProductName(title);

    const existing = await prisma.existingCombination.findUnique({ where: { componentKey } });
    if (existing && existing.normalizedTitle !== normalizedTitle) {
      skipped.push({
        sheet: def.sheet,
        rowNumber: excelRowNumber,
        title,
        reason: `componentKey collision — same component set already imported as "${existing.title}"`,
        componentKey,
      });
      continue;
    }

    await prisma.existingCombination.upsert({
      where: { componentKey },
      update: {
        title,
        normalizedTitle,
        type: def.type,
        componentProductsJson: componentTitles,
        tagLine,
      },
      create: {
        title,
        normalizedTitle,
        type: def.type,
        componentProductsJson: componentTitles,
        componentKey,
        tagLine,
      },
    });
    imported++;
  }

  return { imported, skipped };
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

  const productTitleIndex = new Set(
    (await prisma.fragranceProduct.findMany({ select: { normalizedTitle: true } })).map(
      (p) => p.normalizedTitle,
    ),
  );

  for (const def of COMBINATION_SHEETS) {
    console.log(`\nImporting ${def.type} combinations from "${def.sheet}"...`);
    const result = await importCombinationSheet(
      workbook,
      def,
      { normalizeProductName, createCombinationKey },
      productTitleIndex,
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
