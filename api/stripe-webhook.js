// api/stripe-webhook.js
// ─────────────────────────────────────────────────────────────────────────────
// Receives Stripe webhook events and keeps Firestore in sync.
// Must be registered in Stripe Dashboard → Webhooks with these events:
//   customer.subscription.created
//   customer.subscription.updated
//   customer.subscription.deleted
//   invoice.payment_failed
// ─────────────────────────────────────────────────────────────────────────────

import Stripe from "stripe";
import { setUserTier, downgradeUser } from "./firestoreUser.js";

// Vercel serverless: disable body parsing so we can read the raw buffer
// needed for Stripe signature verification
export const config = { api: { bodyParser: false } };

// Read raw body — works whether Vercel parsed it or not
function getRawBody(req) {
  // If Vercel already parsed the body, reconstruct it
  if (req.body) {
    const raw = typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body);
    return Promise.resolve(Buffer.from(raw));
  }
  // Otherwise stream it
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    req.on("end",  () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const secretKey    = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secretKey || !webhookSecret) {
    console.error("Stripe env vars not set");
    return res.status(500).end();
  }

  const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });

  // ── Verify Stripe signature ───────────────────────────────────────────────
  let event;
  try {
    const rawBody = await getRawBody(req);
    const sig     = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  // ── Handle events ─────────────────────────────────────────────────────────
  try {
    const obj = event.data.object;

    switch (event.type) {

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const uid = obj.metadata?.firebaseUid;
        if (!uid) { console.warn("No firebaseUid in subscription metadata"); break; }

        const isActive = ["active", "trialing"].includes(obj.status);
        if (isActive) {
          await setUserTier(uid, {
            tier:                 "starter",
            stripeCustomerId:     obj.customer,
            stripeSubscriptionId: obj.id,
          });
          console.log(`✅ Upgraded ${uid} to starter`);
        } else {
          // Subscription exists but not active (past_due, etc.) — downgrade
          await downgradeUser(uid);
          console.log(`⬇️ Downgraded ${uid} (status: ${obj.status})`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const uid = obj.metadata?.firebaseUid;
        if (!uid) { console.warn("No firebaseUid in subscription metadata"); break; }
        await downgradeUser(uid);
        console.log(`⬇️ Subscription cancelled — downgraded ${uid}`);
        break;
      }

      case "invoice.payment_failed": {
        // Optionally downgrade immediately on failure, or wait for subscription.updated
        // We log it here but let Stripe retry — subscription.updated will fire when
        // the grace period expires and status becomes "past_due" / "canceled"
        console.log("⚠️ Payment failed for customer:", obj.customer);
        break;
      }

      default:
        // Ignore unhandled events
        break;
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).json({ error: "Webhook handler failed" });
  }
}
