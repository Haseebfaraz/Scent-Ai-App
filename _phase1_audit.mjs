import { analyzeCustomerProductCandidates } from "./app/services/orderHistoryAnalysis.server.js";
import { getCalendarSeason, weatherDirectionToQuerySeason } from "./app/utils/weatherSeason.js";
import { textToPreferenceFamilies } from "./app/utils/fragranceCompatibility.js";
import { likeMatchStrength } from "./app/utils/fragranceScoring.js";
import prisma from "./app/db.server.js";

const MAX_ANCHORS = 5;

const profile = {
  city: "Las Vegas", country: "United States", likes: ["Floral"],
  dislikes: ["Musk", "Oakmoss", "Sandalwood", "Patchouli", "Vetiver"],
  weatherDirection: "hot", locationVerified: true,
};
const season = weatherDirectionToQuerySeason(profile.weatherDirection, getCalendarSeason(profile.country));
const queriedProfile = { ...profile, season };
const candidates = await analyzeCustomerProductCandidates(queriedProfile);
const likeFamilies = textToPreferenceFamilies(profile.likes);

const sorted = candidates.slice().sort((a, b) => b.relevanceScore - a.relevanceScore);
const anchorSet = new Set(sorted.slice(0, MAX_ANCHORS).map((c) => c.productName));

console.log(`Candidate pool size: ${candidates.length}\n`);
console.log("rank | product | relevanceScore | preferenceMatches | floralStrength | sameCity/Country/Season | anchor?");
sorted.forEach((c, i) => {
  const floralStrength = likeMatchStrength(c.orderHistoryNotes, "floral");
  console.log(
    `${i + 1}. ${c.productName} | relevance=${c.relevanceScore} | pref=${JSON.stringify(c.preferenceMatches)} | floralStrength=${floralStrength.toFixed(3)} | city=${c.sameCityOrders},country=${c.sameCountryOrders},season=${c.sameSeasonOrders} | anchor=${anchorSet.has(c.productName)}`,
  );
});

const wicked = sorted.find((c) => c.productName === "Wicked! Femme");
console.log("\nWicked! Femme rank:", sorted.indexOf(wicked) + 1, "of", sorted.length);
console.log("Wicked! Femme relevanceScore:", wicked?.relevanceScore, "floralStrength:", wicked ? likeMatchStrength(wicked.orderHistoryNotes, "floral").toFixed(3) : null);

await prisma.$disconnect();
