// api/firebaseAdmin.js
// ─────────────────────────────────────────────────────────────────────────────
// Initialises Firebase Admin SDK once (singleton pattern) and exports
// `adminDb` (Firestore) and `verifyIdToken`.
// Reads credentials from FIREBASE_ADMIN_CONFIG env var (JSON string of the
// service-account key file).
// ─────────────────────────────────────────────────────────────────────────────

import admin from "firebase-admin";

let initialised = false;

function init() {
  if (initialised || admin.apps.length > 0) { initialised = true; return; }

  const raw = process.env.FIREBASE_ADMIN_CONFIG;
  if (!raw) throw new Error("FIREBASE_ADMIN_CONFIG env var is not set");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_ADMIN_CONFIG is not valid JSON");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  initialised = true;
}

// Verify a Firebase ID token from the Authorization header.
// Returns the decoded token (contains uid, email, etc.).
export async function verifyIdToken(authHeader) {
  init();
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or malformed Authorization header");
  }
  const token = authHeader.slice(7);
  return admin.auth().verifyIdToken(token);
}

// Firestore client (lazily initialised)
export function getDb() {
  init();
  return admin.firestore();
}
