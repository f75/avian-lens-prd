// api/debug-env.js
// Temporary diagnostic endpoint — shows which env vars are present.
// Does NOT expose values. Remove after confirming everything works.
export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const vars = [
    "ANTHROPIC_API_KEY",
    "FIREBASE_ADMIN_CONFIG",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "EBIRD_API_KEY",
  ];

  const status = {};
  for (const v of vars) {
    const val = process.env[v];
    if (!val) { status[v] = "❌ MISSING"; continue; }
    // For FIREBASE_ADMIN_CONFIG, also try parsing it
    if (v === "FIREBASE_ADMIN_CONFIG") {
      try {
        const parsed = JSON.parse(val);
        status[v] = `✅ set — project_id: ${parsed.project_id}, client_email: ${parsed.client_email?.slice(0,20)}...`;
      } catch(e) {
        status[v] = `⚠️  set but invalid JSON: ${e.message}`;
      }
    } else {
      status[v] = `✅ set (${val.length} chars, starts: ${val.slice(0,8)}...)`;
    }
  }

  return res.status(200).json({ env: status, node: process.version });
}
