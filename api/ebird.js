// Serverless function: look up eBird occurrence counts for specific candidate species
// GET /api/ebird?lat=37.5&lng=-122.1&candidates=American+Robin|House+Sparrow|Cooper%27s+Hawk

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { lat, lng, candidates } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });

  const eBirdKey = process.env.EBIRD_API_KEY;
  if (!eBirdKey) return res.status(500).json({ error: "EBIRD_API_KEY not configured" });

  try {
    // Fetch up to 3000 recent observations within 75km, last 30 days
    const url = `https://api.ebird.org/v2/data/obs/geo/recent?lat=${lat}&lng=${lng}&dist=75&back=30&maxResults=3000`;
    const resp = await fetch(url, { headers: { "x-ebirdapitoken": eBirdKey } });
    if (!resp.ok) return res.status(502).json({ error: "eBird API error" });

    const obs = await resp.json();

    // Build frequency map: comName → { count, lastSeen, maxCount }
    const freq = {};
    for (const o of obs) {
      const n = o.comName;
      if (!n) continue;
      if (!freq[n]) freq[n] = { count: 0, lastSeen: o.obsDt, maxFlock: 0 };
      freq[n].count++;
      if (o.howMany && o.howMany > freq[n].maxFlock) freq[n].maxFlock = o.howMany;
      if (o.obsDt > freq[n].lastSeen) freq[n].lastSeen = o.obsDt;
    }

    // Total unique species for context
    const totalSpecies = Object.keys(freq).length;
    const totalObs = obs.length;

    // Score the specific candidate species
    const candidateList = candidates ? candidates.split("|").map(s => s.trim()) : [];
    const scores = {};
    for (const name of candidateList) {
      // Try exact match first, then case-insensitive
      const key = freq[name]
        ? name
        : Object.keys(freq).find(k => k.toLowerCase() === name.toLowerCase());
      if (key) {
        scores[name] = {
          observed: true,
          obsCount: freq[key].count,
          lastSeen: freq[key].lastSeen,
          maxFlock: freq[key].maxFlock,
          // Rarity tier: common >20, uncommon 5-20, rare 1-4, absent 0
          rarity: freq[key].count > 20 ? "common" : freq[key].count > 4 ? "uncommon" : "rare",
        };
      } else {
        scores[name] = { observed: false, obsCount: 0, rarity: "absent" };
      }
    }

    // Top 20 most-observed species for context
    const topSpecies = Object.entries(freq)
      .sort(([,a],[,b]) => b.count - a.count)
      .slice(0, 20)
      .map(([name, d]) => ({ name, count: d.count, rarity: d.count > 20 ? "common" : d.count > 4 ? "uncommon" : "rare" }));

    return res.status(200).json({ scores, topSpecies, totalSpecies, totalObs, radius: 75, days: 30 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
