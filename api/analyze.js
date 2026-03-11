export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    return res.status(200).end();
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    const { messages, model, maxTokens, location } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Missing messages array" });
    }

    // Check API key early — give a clear error instead of a cryptic 401
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server. Add it in Vercel → Settings → Environment Variables." });
    }

    // ── eBird: fetch regional species server-side if location has coords ──
    let eBirdSpecies = [];
    const eBirdKey = process.env.EBIRD_API_KEY;
    if (eBirdKey && location) {
      const coords = parseCoords(location);
      if (coords) {
        try {
          const url = `https://api.ebird.org/v2/data/obs/geo/recent?lat=${coords.lat}&lng=${coords.lng}&dist=50&back=30&maxResults=200`;
          const er = await fetch(url, { headers: { "x-ebirdapitoken": eBirdKey } });
          if (er.ok) {
            const data = await er.json();
            const seen = new Set();
            eBirdSpecies = data.map(o => o.comName).filter(n => n && !seen.has(n) && seen.add(n));
          }
        } catch(_) {}
      }
    }

    // ── Inject eBird species list into the last user message if it's Pass 2 ──
    // Pass 2 is text-only (no image blocks) — inject species context there
    const enrichedMessages = messages.map((msg, idx) => {
      if (
        idx === messages.length - 1 &&
        eBirdSpecies.length > 0 &&
        typeof msg.content === "string" &&
        msg.content.includes("FIELD NOTES:")
      ) {
        return {
          ...msg,
          content: msg.content.replace(
            "Geographic location:",
            `RECENTLY OBSERVED IN THIS AREA (eBird last 30 days — strong prior):\n${eBirdSpecies.slice(0, 80).join(", ")}\n\nGeographic location:`
          ),
        };
      }
      return msg;
    });

    // ── Call Anthropic ────────────────────────────────────────────────────
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || "claude-haiku-4-5-20251001" // caller always passes the right model, // caller passes correct model per tier
        max_tokens: maxTokens || 1200,
        messages: enrichedMessages,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("Anthropic error:", data);
      return res.status(response.status).json({ error: data.error?.message || "API error" });
    }

    // Pass eBird count back so UI can show it
    return res.status(200).json({ ...data, _eBirdCount: eBirdSpecies.length });

  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}

// Parse lat/lng from free-text location
function parseCoords(loc) {
  if (!loc) return null;
  const dms = loc.match(/([0-9.]+)[°\s]*([NS])[,\s]+([0-9.]+)[°\s]*([EW])/i);
  if (dms) {
    let lat = parseFloat(dms[1]), lng = parseFloat(dms[3]);
    if (/S/i.test(dms[2])) lat = -lat;
    if (/W/i.test(dms[4])) lng = -lng;
    return { lat, lng };
  }
  const dec = loc.match(/(-?[0-9]+\.?[0-9]*)[,\s]+(-?[0-9]+\.?[0-9]*)/);
  if (dec) {
    const a = parseFloat(dec[1]), b = parseFloat(dec[2]);
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b };
  }
  return null;
}
