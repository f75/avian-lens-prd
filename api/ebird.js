// Serverless function: look up eBird occurrence counts for specific candidate species
// GET /api/ebird?lat=37.5&lng=-122.1&candidates=American+Robin|House+Sparrow&obsDate=2024-05-15

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { lat, lng, candidates, obsDate } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });

  const eBirdKey = process.env.EBIRD_API_KEY;
  if (!eBirdKey) return res.status(500).json({ error: "EBIRD_API_KEY not configured" });

  try {
    // If obsDate provided, use ±15 day window centred on that date (last 30 days from date)
    // eBird "back" param = days back from today, max 30. If date is in the past beyond 30 days,
    // clamp to 30 days. For historic dates, we use the "back" param relative to today.
    let back = 30;
    let dateLabel = "last 30 days";
    if (obsDate) {
      const obs = new Date(obsDate);
      const today = new Date();
      const daysAgo = Math.round((today - obs) / 86400000);
      if (daysAgo >= 0 && daysAgo <= 30) {
        back = Math.max(1, daysAgo + 15); // window around the observation date
        back = Math.min(back, 30);
        dateLabel = `around ${obsDate}`;
      } else if (daysAgo > 30) {
        // For older dates use seasonal window — fetch by month using recent year eBird data
        // Fall back to 30-day pull but note the limitation
        back = 30;
        dateLabel = `seasonal data (obs date ${obsDate} is >30 days ago)`;
      }
    }

    // Fetch recent observations within 75km
    const url = `https://api.ebird.org/v2/data/obs/geo/recent?lat=${lat}&lng=${lng}&dist=75&back=${back}&maxResults=3000`;
    const resp = await fetch(url, { headers: { "x-ebirdapitoken": eBirdKey } });
    if (!resp.ok) return res.status(502).json({ error: "eBird API error" });

    const obs = await resp.json();

    // Build frequency map: comName → { count, lastSeen, maxFlock, obsDates[] }
    const freq = {};
    for (const o of obs) {
      const n = o.comName;
      if (!n) continue;
      if (!freq[n]) freq[n] = { count: 0, lastSeen: o.obsDt, maxFlock: 0 };
      freq[n].count++;
      if (o.howMany && o.howMany > freq[n].maxFlock) freq[n].maxFlock = o.howMany;
      if (o.obsDt > freq[n].lastSeen) freq[n].lastSeen = o.obsDt;
    }

    const totalSpecies = Object.keys(freq).length;
    const totalObs = obs.length;

    // Score the specific candidate species
    const candidateList = candidates ? candidates.split("|").map(s => s.trim()) : [];
    const scores = {};
    for (const name of candidateList) {
      const key = freq[name]
        ? name
        : Object.keys(freq).find(k => k.toLowerCase() === name.toLowerCase());
      if (key) {
        const f = freq[key];
        scores[name] = {
          observed: true,
          obsCount: f.count,
          lastSeen: f.lastSeen,
          maxFlock: f.maxFlock,
          rarity: f.count > 20 ? "common" : f.count > 4 ? "uncommon" : "rare",
        };
      } else {
        scores[name] = { observed: false, obsCount: 0, rarity: "absent" };
      }
    }

    // Top 20 most-observed species for context
    const topSpecies = Object.entries(freq)
      .sort(([,a],[,b]) => b.count - a.count)
      .slice(0, 20)
      .map(([name, d]) => ({
        name, count: d.count,
        rarity: d.count > 20 ? "common" : d.count > 4 ? "uncommon" : "rare",
      }));

    return res.status(200).json({ scores, topSpecies, totalSpecies, totalObs, radius: 75, back, dateLabel });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
