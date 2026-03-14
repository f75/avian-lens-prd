// api/firestoreUser.js
// ─────────────────────────────────────────────────────────────────────────────
// All Firestore read/write operations for the /users/{uid} collection.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "./firebaseAdmin.js";
import admin from "firebase-admin";

const USERS = "users";

// ── Get or create a user document ───────────────────────────────────────────
export async function getOrCreateUser(uid, { email, displayName, photoURL } = {}) {
  const db  = getDb();
  const ref = db.collection(USERS).doc(uid);
  const doc = await ref.get();

  if (doc.exists) return doc.data();

  // First sign-in — create the document
  const now  = admin.firestore.Timestamp.now();
  const user = {
    uid,
    email:          email          ?? "",
    displayName:    displayName    ?? "",
    photoURL:       photoURL       ?? "",
    tier:           "free",
    stripeCustomerId:     null,
    stripeSubscriptionId: null,
    analysisCount:  0,
    analysisResetDate: firstOfNextMonth(),
    createdAt:      now,
    updatedAt:      now,
  };

  await ref.set(user);
  return user;
}

// ── Get a user document (throws if not found) ────────────────────────────────
export async function getUser(uid) {
  const db  = getDb();
  const doc = await db.collection(USERS).doc(uid).get();
  if (!doc.exists) throw new Error(`User ${uid} not found`);
  return doc.data();
}

// ── Check usage and increment atomically ─────────────────────────────────────
// Returns { allowed: bool, count: number, limit: number, tier: string }
export async function checkAndIncrementUsage(uid, limit) {
  const db  = getDb();
  const ref = db.collection(USERS).doc(uid);

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw new Error("User document not found");

    const data  = doc.data();
    const now   = admin.firestore.Timestamp.now();

    // Reset count if we've passed the reset date
    let count = data.analysisCount ?? 0;
    const resetDate = data.analysisResetDate?.toDate?.() ?? new Date();
    if (now.toDate() >= resetDate) {
      count = 0;
      tx.update(ref, {
        analysisCount:    0,
        analysisResetDate: firstOfNextMonth(),
        updatedAt:         now,
      });
    }

    if (count >= limit) {
      return { allowed: false, count, limit, tier: data.tier ?? "free" };
    }

    tx.update(ref, {
      analysisCount: admin.firestore.FieldValue.increment(1),
      updatedAt:     now,
    });

    return { allowed: true, count: count + 1, limit, tier: data.tier ?? "free" };
  });
}

// ── Update tier and Stripe IDs after successful payment ──────────────────────
export async function setUserTier(uid, { tier, stripeCustomerId, stripeSubscriptionId }) {
  const db  = getDb();
  const ref = db.collection(USERS).doc(uid);
  await ref.update({
    tier,
    ...(stripeCustomerId     ? { stripeCustomerId }     : {}),
    ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
    updatedAt: admin.firestore.Timestamp.now(),
  });
}

// ── Downgrade to free on cancellation / payment failure ──────────────────────
export async function downgradeUser(uid) {
  const db  = getDb();
  await db.collection(USERS).doc(uid).update({
    tier:                 "free",
    stripeSubscriptionId: null,
    updatedAt:            admin.firestore.Timestamp.now(),
  });
}

// ── Helper: first day of next month at midnight UTC ──────────────────────────
function firstOfNextMonth() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return admin.firestore.Timestamp.fromDate(d);
}
