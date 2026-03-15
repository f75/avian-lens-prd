// api/stripe-webhook.js
import Stripe from "stripe";
import { setUserTier, downgradeUser } from "./firestoreUser.js";
import { getDb } from "./firebaseAdmin.js";

export const config = { api: { bodyParser: false } };

// Stream raw bytes — critical for Stripe signature verification
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end",  () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Look up firebaseUid by stripeCustomerId — fallback when metadata is missing
async function uidFromCustomerId(customerId) {
  try {
    const db = getDb();
    const snap = await db.collection("users")
      .where("stripeCustomerId", "==", customerId)
      .limit(1)
      .get();
    if (!snap.empty) return snap.docs[0].id;
  } catch(e) {
    console.error("uidFromCustomerId error:", e.message);
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const secretKey     = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secretKey || !webhookSecret) {
    console.error("❌ Stripe env vars missing");
    return res.status(500).end();
  }

  const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });

  // ── Verify Stripe signature ───────────────────────────────────────────────
  let event;
  try {
    const rawBody = await getRawBody(req);
    const sig     = req.headers["stripe-signature"];
    console.log("Webhook received:", req.headers["stripe-signature"]?.slice(0, 30));
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    console.log("✅ Signature verified, event:", event.type);
  } catch (err) {
    console.error("❌ Signature failed:", err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  // ── Handle events ─────────────────────────────────────────────────────────
  try {
    const obj = event.data.object;
    console.log("Event object id:", obj.id, "| customer:", obj.customer);

    switch (event.type) {

      case "checkout.session.completed": {
        console.log("checkout metadata:", JSON.stringify(obj.metadata));
        console.log("payment_status:", obj.payment_status);
        // Get uid from metadata, fallback to customer lookup
        let uid = obj.metadata?.firebaseUid;
        if (!uid && obj.customer) uid = await uidFromCustomerId(obj.customer);
        if (!uid) { console.error("❌ Cannot resolve uid for customer:", obj.customer); break; }
        if (obj.payment_status === "paid") {
          await setUserTier(uid, { tier: "starter", stripeCustomerId: obj.customer });
          console.log(`✅ Upgraded ${uid} → starter (checkout.session.completed)`);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        console.log("subscription metadata:", JSON.stringify(obj.metadata));
        console.log("subscription status:", obj.status);
        let uid = obj.metadata?.firebaseUid;
        if (!uid && obj.customer) uid = await uidFromCustomerId(obj.customer);
        if (!uid) { console.error("❌ Cannot resolve uid for customer:", obj.customer); break; }
        const isActive = ["active", "trialing"].includes(obj.status);
        if (isActive) {
          await setUserTier(uid, {
            tier: "starter",
            stripeCustomerId: obj.customer,
            stripeSubscriptionId: obj.id,
          });
          console.log(`✅ Upgraded ${uid} → starter (${event.type})`);
        } else {
          await downgradeUser(uid);
          console.log(`⬇️ Downgraded ${uid} (status: ${obj.status})`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        let uid = obj.metadata?.firebaseUid;
        if (!uid && obj.customer) uid = await uidFromCustomerId(obj.customer);
        if (!uid) { console.error("❌ Cannot resolve uid for customer:", obj.customer); break; }
        await downgradeUser(uid);
        console.log(`⬇️ Subscription cancelled — downgraded ${uid}`);
        break;
      }

      case "invoice.payment_failed": {
        console.log("⚠️ Payment failed for customer:", obj.customer);
        break;
      }

      default:
        console.log("Unhandled event type:", event.type);
        break;
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    return res.status(500).json({ error: "Webhook handler failed" });
  }
}
