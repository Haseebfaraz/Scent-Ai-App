// scripts/seed-notes.cjs
//
// Reads data/notes.csv and data/order_history.csv, cleans them, and
// loads them into the database via Prisma.
//
// Run with: node scripts/seed-notes.cjs

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function loadCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { data } = Papa.parse(raw, { header: true, skipEmptyLines: true });
  return data;
}

async function main() {
  const notesPath = path.join(__dirname, '..', 'data', 'notes.csv');
  const ordersPath = path.join(__dirname, '..', 'data', 'order_history.csv');

  if (!fs.existsSync(notesPath)) {
    console.error(`Missing file: ${notesPath}`);
    console.error('Make sure your notes CSV is saved there as "notes.csv".');
    process.exit(1);
  }
  if (!fs.existsSync(ordersPath)) {
    console.error(`Missing file: ${ordersPath}`);
    console.error('Make sure your order history CSV is saved there as "order_history.csv".');
    process.exit(1);
  }

  const notesRaw = loadCSV(notesPath);
  const ordersRaw = loadCSV(ordersPath);

  // ---------- Step 1: figure out each note's dominant "family" ----------
  // by tallying which Classification it most often appears under
  // across past orders.
  const familyTally = {}; // { noteName: { classification: count } }

  for (const row of ordersRaw) {
    const rawClass = (row['Classification'] || '')
      .replace(/^CLASSIFICATION:\s*/i, '')
      .trim();
    if (!rawClass) continue;

    const notesList = (row['Notes'] || '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);

    for (const noteName of notesList) {
      if (!familyTally[noteName]) familyTally[noteName] = {};
      familyTally[noteName][rawClass] = (familyTally[noteName][rawClass] || 0) + 1;
    }
  }

  function topFamily(noteName) {
    const tally = familyTally[noteName];
    if (!tally) return null;
    return Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
  }

  // ---------- Step 2: seed the notes table ----------
  let noteCount = 0;
  for (const row of notesRaw) {
    const name = (row['Notes'] || '').trim();
    if (!name) continue;

    const top = parseInt(row['Top'], 10) || 0;
    const middle = parseInt(row['Middle'], 10) || 0;
    const base = parseInt(row['Base'], 10) || 0;
    const density = parseFloat(row['Average Density']) || 0;

    const max = Math.max(top, middle, base);
    const position = max === top ? 'top' : max === middle ? 'middle' : 'base';

    await prisma.note.upsert({
      where: { name },
      update: { position, density, family: topFamily(name) },
      create: { name, position, density, family: topFamily(name) },
    });
    noteCount++;
  }
  console.log(`Seeded ${noteCount} notes.`);

  // ---------- Step 3: seed cleaned order history (region kept, Name/Race/Gender dropped) ----------
  // Clear old rows first so re-running this script doesn't duplicate them.
  await prisma.orderHistory.deleteMany({});

  const cleanedOrders = ordersRaw.map((row) => ({
    orderDate: row['Order Date'] || null,
    season: row['Updated Season'] || null,
    classification:
      (row['Classification'] || '').replace(/^CLASSIFICATION:\s*/i, '').trim() || null,
    notes: (row['Notes'] || '').trim(),
    // Region only — deliberately still not seeding Name/Race/Gender from the source CSV.
    city: (row['City'] || '').trim() || null,
    stateName: (row['State Name'] || '').trim() || null,
    countryName: (row['Country Name'] || '').trim() || null,
  }));

  const BATCH_SIZE = 1000;
  let orderCount = 0;
  for (let i = 0; i < cleanedOrders.length; i += BATCH_SIZE) {
    const batch = cleanedOrders.slice(i, i + BATCH_SIZE);
    await prisma.orderHistory.createMany({ data: batch });
    orderCount += batch.length;
    console.log(`  ...${orderCount} / ${cleanedOrders.length} order rows seeded`);
  }
  console.log(`Seeded ${orderCount} order history rows (city/state/country kept, Name/Race/Gender dropped).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
