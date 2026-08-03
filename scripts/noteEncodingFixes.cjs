// scripts/noteEncodingFixes.cjs
//
// Best-effort correction for a real, permanent upstream data-corruption bug: the master catalog
// spreadsheet (data/Notes-Extraction-Separated-hybird.xlsx) already contains the Unicode
// replacement character (U+FFFD, re-mangled through a Latin-1 misread into the literal 3-character
// sequence "ï¿½") wherever an accented letter, apostrophe, or trademark symbol used to be — the
// original byte was destroyed before this codebase ever touched the data (confirmed against both
// the source .xlsx and data/Notes-Extraction-Separated.backup-before-encoding-fix.csv, byte-for-byte
// identical corruption in both). There is no way to recover the TRUE original character; every
// entry below is a hand-curated best guess from recognizable perfumery/food vocabulary (Purée,
// Crème, Maté, Açaí...) and real captive-molecule trade names (Ambrofix®, Orcanox®, Craftivity®...).
// Entries marked LOW CONFIDENCE are genuinely ambiguous between an accent and a trademark symbol.
//
// Applied in two places: scripts/fix-note-encoding.cjs (one-off migration correcting rows already
// in the live DB) and scripts/import-hybrid-catalog.cjs (so re-running the import against the same,
// still-corrupted source file never reintroduces the bug).
const CORRECTIONS = {
  "Matï¿½": "Maté",
  "Strawberry Purï¿½e": "Strawberry Purée",
  "Orcanoxï¿½": "Orcanox®",
  "Crï¿½me De Cassis": "Crème De Cassis",
  "Ambrofixï¿½": "Ambrofix®",
  "Raspberry Purï¿½e": "Raspberry Purée",
  "Crï¿½me Brï¿½lï¿½e": "Crème Brûlée",
  "Lab-Engineered Vanilla Pheraï¿½Moan": "Lab-Engineered Vanilla Phera'Moan",
  "Vanilla Musk Pheroï¿½moan Accord": "Vanilla Musk Phero'moan Accord",
  "Oud Assafiï¿½": "Oud Assafi®", // LOW CONFIDENCE — could be an accent instead of a trademark
  "Vanilla Crï¿½me": "Vanilla Crème",
  "Up to the wearer to determine! Thatï¿½s the mystery of Mysterious\r\nElixir!":
    "Up to the wearer to determine! That's the mystery of Mysterious\r\nElixir!",
  "Rum Pure Jungle Essenceï¿½": "Rum Pure Jungle Essence®",
  "and Sicilian Citruses Fruit Mï¿½lange with Vanilla Extrait": "and Sicilian Citruses Fruit Mélange with Vanilla Extrait",
  "Arabian Taï¿½f Rose": "Arabian Taïf Rose",
  "Juicy Aï¿½ai": "Juicy Açaí",
  "Dyerï¿½s Greenweed": "Dyer's Greenweed",
  "Precious Woods and Melï¿½nge of Musks": "Precious Woods and Mélange of Musks",
  "Sicilian Citruses Fruit Mï¿½lange with Vanilla Extrait": "Sicilian Citruses Fruit Mélange with Vanilla Extrait",
  "Fougï¿½re Accord": "Fougère Accord",
  "Rose from Taï¿½if": "Rose from Ta'if",
  "Green Matï¿½ Absolute": "Green Maté Absolute",
  "ï¿½Starfishï¿½ Accord": "'Starfish' Accord",
  "Creamy Chai Lattï¿½": "Creamy Chai Latté",
  "and Matï¿½": "and Maté",
  "Yerba Matï¿½": "Yerba Maté",
  "Passion Fruit Purï¿½e": "Passion Fruit Purée",
  "Sweet Banana Purï¿½e": "Sweet Banana Purée",
  "Aï¿½ai Berry": "Açaí Berry",
  "Peach Purï¿½e": "Peach Purée",
  "Jalapeï¿½o": "Jalapeño",
  "Valencia Orange Crï¿½me": "Valencia Orange Crème",
  "Vanilla Pastry Crï¿½me": "Vanilla Pastry Crème",
  "Pineapple Pureï¿½": "Pineapple Purée",
  "Cherry Purï¿½e": "Cherry Purée",
  "Cupuaï¿½u": "Cupuaçu",
  "Sï¿½mores": "S'mores",
  "Pï¿½te Feuilletï¿½e": "Pâte Feuilletée",
  "Ultravanilï¿½": "Ultravanil®", // LOW CONFIDENCE — could be "Ultravanille" instead of a trademark
  "Tiramisï¿½ Accord": "Tiramisù Accord",
  "White Tiarï¿½ Flower": "White Tiaré Flower",
  "Musky Ambrofixï¿½": "Musky Ambrofix®",
  "Black Sï¿½sam Extract CO2": "Black Sésame Extract CO2",
  "Pralinï¿½": "Praliné",
  "Vanilla Crï¿½me Pastry": "Vanilla Crème Pastry",
  "Cï¿½dre-sur-Orris": "Cèdre-sur-Orris",
  "Powdered Confectionerï¿½s Sugar": "Powdered Confectioner's Sugar",
  "Burnt Crï¿½me Brï¿½lï¿½e": "Burnt Crème Brûlée",
  "Brï¿½lï¿½ed Vanilla Custard": "Brûléed Vanilla Custard",
  "Crï¿½me Dessert Pistache de Bronte": "Crème Dessert Pistache de Bronte",
  "Coconut Rapï¿½": "Coconut Rapé",
  "Ambroxï¿½ Super": "Ambrox® Super", // LOW CONFIDENCE — could be "Ambroxan Super" instead
  "Vanilla Jungle Essenceï¿½": "Vanilla Jungle Essence®",
  "Vanilla Soufflï¿½ Accord": "Vanilla Soufflé Accord",
  "Crï¿½me De Coconut": "Crème De Coconut",
  "Chantilly Crï¿½me": "Chantilly Crème",
  "Piï¿½a Colada": "Piña Colada",
  "Warm Vanilla Crï¿½me": "Warm Vanilla Crème",
  "Cafï¿½ Au Lait": "Café Au Lait",
  "Benzoin Siam Resinoï¿½d": "Benzoin Siam Resinoid",
  "Cï¿½drat": "Cédrat",
  "Jasmine Sambac India Craftivityï¿½": "Jasmine Sambac India Craftivity®",
  "Cacao Blanc Peru Craftivityï¿½": "Cacao Blanc Peru Craftivity®",
  "Osmanthus China Craftivityï¿½": "Osmanthus China Craftivity®",
  "Red Velvet Crï¿½me": "Red Velvet Crème",
  "Cafï¿½ Arabica": "Café Arabica",
  "Amberxtremeï¿½": "Amberxtreme®",
  "Inc. Sinfonideï¿½": "Inc. Sinfonide®",
  "Crï¿½me de Cassis": "Crème de Cassis",
  "Blue Vanilla NaturePrintï¿½": "Blue Vanilla NaturePrint®",
  "Woody Citrus Pheroï¿½moanï¿½": "Woody Citrus Phero'moan®",
  "Citrus Musk Pheroï¿½moan Accord": "Citrus Musk Phero'moan Accord",
  "Lab Engineered Citrus Musk Pheraï¿½moan Accord": "Lab Engineered Citrus Musk Phera'moan Accord",
  "Woody Citrus Phereï¿½moan Accord": "Woody Citrus Phere'moan Accord",
  "Maple Caramel Crï¿½me": "Maple Caramel Crème",
  "Ambrexolideï¿½": "Ambrexolide®",
  "Lab-Engineered Citrus Musk Phero'moanï¿½": "Lab-Engineered Citrus Musk Phero'moan®",
};

// Longest keys first — several are substrings of a longer, more specific one (e.g. "Matï¿½" is
// itself a substring of "Green Matï¿½ Absolute"); replacing the generic one first would make the
// longer, more specific key un-matchable afterward.
const ORDERED_KEYS = Object.keys(CORRECTIONS).sort((a, b) => b.length - a.length);

function fixNoteEncoding(text) {
  if (typeof text !== "string" || !text.includes("ï¿½")) return text;
  let fixed = text;
  for (const bad of ORDERED_KEYS) {
    if (fixed.includes(bad)) fixed = fixed.split(bad).join(CORRECTIONS[bad]);
  }
  return fixed;
}

module.exports = { fixNoteEncoding, CORRECTIONS };
