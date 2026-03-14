// api/create-checkout-session.js
// ─────────────────────────────────────────────────────────────────────────────
// Creates a Stripe Checkout session for the authenticated user and returns
// the hosted URL to redirect to.
// ─────────────────────────────────────────────────────────────────────────────

import Stripe from "stripe";
import { verifyIdToken } from "./firebaseAdmin.js";
import { getOrCreateUser, setUserTier } from "./firestoreUser.js";
import { TIER_CONFIG } from "../src/tierConfig.js";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  try {
    // ── Auth ────────────────────────────────────────────────────────────────
    let decoded;
    try {
      decoded = await verifyIdToken(req.headers.authorization);
    } catch {
      return res.status(401).json({ error: "Unauthorised — please sign in" });
    }

    // ── Stripe setup ────────────────────────────────────────────────────────
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) return res.status(500).json({ error: "Stripe not configured" });

    const stripe    = new Stripe(secretKey, { apiVersion: "2024-06-20" });
    const priceId   = TIER_CONFIG.starter.stripePriceId;
    const { origin } = req.body;  // frontend passes its own origin for redirect URLs

    // ── Get or create Stripe customer ───────────────────────────────────────
    const user = await getOrCreateUser(decoded.uid, {
      email:       decoded.email,
      displayName: decoded.name,
      photoURL:    decoded.picture,
    });

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    decoded.email ?? "",
        name:     decoded.name  ?? "",
        metadata: { firebaseUid: decoded.uid },
      });
      customerId = customer.id;
      // Persist the customer ID immediately so we can find this user in webhooks
      await setUserTier(decoded.uid, {
        tier:             user.tier,
        stripeCustomerId: customerId,
      });
    }

    // ── Create Checkout session ─────────────────────────────────────────────
    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      mode:                 "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/?checkout=success`,
      cancel_url:  `${origin}/?checkout=cancel`,
      metadata: { firebaseUid: decoded.uid },
      subscription_data: {
        metadata: { firebaseUid: decoded.uid },
      },
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("Checkout error:", err);
    return res.status(500).json({ error: err.message || "Could not create checkout session" });
  }
}
