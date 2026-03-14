// api/user-profile.js
// ─────────────────────────────────────────────────────────────────────────────
// Returns the authenticated user's profile from Firestore:
//   tier, analysisCount, analysisResetDate, displayName, photoURL
// Called by the frontend immediately after sign-in and on app load.
// ─────────────────────────────────────────────────────────────────────────────

import { verifyIdToken } from "./firebaseAdmin.js";
import { getOrCreateUser } from "./firestoreUser.js";
import { getTierConfig } from "../src/tierConfig.js";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "Method not allowed" });

  try {
    // ── Auth ────────────────────────────────────────────────────────────────
    let decoded;
    try {
      decoded = await verifyIdToken(req.headers.authorization);
    } catch(e) {
      console.error("user-profile auth error:", e.message);
      return res.status(401).json({ error: `Auth failed: ${e.message}` });
    }

    // ── Get or create user doc ───────────────────────────────────────────────
    const user = await getOrCreateUser(decoded.uid, {
      email:       decoded.email,
      displayName: decoded.name,
      photoURL:    decoded.picture,
    });

    const tierCfg = getTierConfig(user.tier);

    // ── Return sanitised profile ─────────────────────────────────────────────
    return res.status(200).json({
      uid:               user.uid,
      email:             user.email,
      displayName:       user.displayName,
      photoURL:          user.photoURL,
      tier:              user.tier,
      tierName:          tierCfg.name,
      analysisLimit:     tierCfg.analysisLimit,
      analysisCount:     user.analysisCount  ?? 0,
      analysisResetDate: user.analysisResetDate?.toDate?.()?.toISOString() ?? null,
      model:             tierCfg.model,
    });

  } catch (err) {
    console.error("user-profile error:", err);
    return res.status(500).json({ error: err.message || "Could not load profile" });
  }
}
