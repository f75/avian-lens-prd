// api/redeem-coupon.js
// ─────────────────────────────────────────────────────────────────────────────
// Validates and redeems a coupon code for the authenticated user.
// All reads/writes happen in a single Firestore transaction to prevent
// race conditions (two users using the last redemption simultaneously).
//
// Coupon document shape in /coupons/{code}:
//   credits:    number     — analyses to add (subtracted from analysisCount)
//   type:       string     — "credits" | "reset" | "upgrade"
//   maxUses:    number     — total redemptions allowed across all users
//   usedCount:  number     — how many times redeemed so far
//   usedBy:     string[]   — uids that have already redeemed (once per user)
//   expiresAt:  Timestamp | null — null = never expires
//   active:     boolean    — false = instantly disabled
// ─────────────────────────────────────────────────────────────────────────────

import { verifyIdToken, getDb } from "./firebaseAdmin.js";
import admin from "firebase-admin";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  // ── Auth ──────────────────────────────────────────────────────────────────
  let decoded;
  try {
    decoded = await verifyIdToken(req.headers.authorization);
  } catch {
    return res.status(401).json({ error: "Please sign in to redeem a coupon" });
  }
  const uid = decoded.uid;

  // ── Input ─────────────────────────────────────────────────────────────────
  const raw  = (req.body?.code ?? "").toString().trim().toUpperCase();
  if (!raw) return res.status(400).json({ error: "Please enter a coupon code" });

  const db          = getDb();
  const couponRef   = db.collection("coupons").doc(raw);
  const userRef     = db.collection("users").doc(uid);

  // ── Transaction: validate then apply atomically ───────────────────────────
  try {
    const result = await db.runTransaction(async (tx) => {
      const [couponDoc, userDoc] = await Promise.all([
        tx.get(couponRef),
        tx.get(userRef),
      ]);

      // ── Validate coupon ───────────────────────────────────────────────────
      if (!couponDoc.exists) {
        return { ok: false, error: "Invalid coupon code" };
      }

      const c = couponDoc.data();

      if (!c.active) {
        return { ok: false, error: "This coupon code is no longer active" };
      }

      // Expiry check
      if (c.expiresAt) {
        const expiry = c.expiresAt.toDate?.() ?? new Date(c.expiresAt);
        if (new Date() > expiry) {
          return { ok: false, error: "This coupon code has expired" };
        }
      }

      // Max uses check
      if (c.usedCount >= c.maxUses) {
        return { ok: false, error: "This coupon code has reached its usage limit" };
      }

      // Once per user check
      if ((c.usedBy ?? []).includes(uid)) {
        return { ok: false, error: "You have already used this coupon code" };
      }

      // ── Validate user ─────────────────────────────────────────────────────
      if (!userDoc.exists) {
        return { ok: false, error: "User account not found" };
      }

      const user    = userDoc.data();
      const now     = admin.firestore.Timestamp.now();

      // ── Apply coupon ──────────────────────────────────────────────────────
      // Update coupon: increment usedCount, push uid into usedBy
      tx.update(couponRef, {
        usedCount: admin.firestore.FieldValue.increment(1),
        usedBy:    admin.firestore.FieldValue.arrayUnion(uid),
        updatedAt: now,
      });

      let creditsAdded = 0;
      let newTier      = user.tier;

      if (c.type === "credits") {
        // Subtract credits from analysisCount (going negative gives headroom)
        const credits = c.credits ?? 0;
        creditsAdded  = credits;
        tx.update(userRef, {
          analysisCount: admin.firestore.FieldValue.increment(-credits),
          updatedAt:     now,
        });
      } else if (c.type === "reset") {
        // Reset count to 0
        tx.update(userRef, {
          analysisCount:     0,
          analysisResetDate: firstOfNextMonth(),
          updatedAt:         now,
        });
        creditsAdded = user.analysisCount ?? 0; // effectively freed this many
      } else if (c.type === "upgrade") {
        // Upgrade to starter tier
        newTier = "starter";
        tx.update(userRef, {
          tier:      "starter",
          updatedAt: now,
        });
      }

      return {
        ok:          true,
        type:        c.type,
        creditsAdded,
        newTier,
        message:
          c.type === "credits" ? `${creditsAdded} analyses added to your account` :
          c.type === "reset"   ? "Your usage counter has been reset" :
          c.type === "upgrade" ? "Your account has been upgraded to Starter" :
          "Coupon applied",
      };
    });

    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    console.log(`✅ Coupon ${raw} redeemed by ${uid} — type: ${result.type}`);
    return res.status(200).json(result);

  } catch (err) {
    console.error("Coupon redemption error:", err);
    return res.status(500).json({ error: "Could not apply coupon. Please try again." });
  }
}

function firstOfNextMonth() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return admin.firestore.Timestamp.fromDate(d);
}
