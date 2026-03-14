// ─────────────────────────────────────────────────────────────────────────────
// TIER CONFIGURATION — edit here to change plans, limits, models, prices
// Used by both the frontend (UI text, model selection) and the backend
// (usage enforcement via api/analyze.js)
// ─────────────────────────────────────────────────────────────────────────────

export const TIER_CONFIG = {
  free: {
    id:             "free",
    name:           "Free",
    tagline:        "Get started — no card needed",
    price:          0,
    priceLabel:     "Free forever",
    analysisLimit:  30,           // analyses per month
    model:          "claude-haiku-4-5-20251001",
    modelLabel:     "Haiku 4.5",
    features: [
      "30 analyses per month",
      "Species identification",
      "Quality score 1–10",
      "EXIF metadata extraction",
      "Photographer tips",
      "Smart quality & species filters",
      "ZIP download of filtered images",
    ],
    cta: "Start Free →",
    highlighted: false,
  },

  starter: {
    id:             "starter",
    name:           "Starter",
    tagline:        "For serious bird photographers",
    price:          10,
    priceLabel:     "$10 / month",
    analysisLimit:  300,          // analyses per month
    model:          "claude-sonnet-4-6",
    modelLabel:     "Sonnet 4.6",
    features: [
      "300 analyses per month",
      "Advanced species analysis",
      "Behaviour & plumage details",
      "eBird regional verification",
      "Social media export",
      "Priority processing",
      "Everything in Free",
    ],
    cta:         "Upgrade to Starter →",
    highlighted: true,
    stripePriceId: "price_1TAduoJUtT1zJ65lBJ6l7v3b",  // Stripe Price ID
  },
};

// Helper — get config by tier id, defaults to free
export const getTierConfig = (tierId) =>
  TIER_CONFIG[tierId] ?? TIER_CONFIG.free;
