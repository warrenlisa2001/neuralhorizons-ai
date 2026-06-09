/**
 * Neural Horizons AI — Cloudflare Worker
 * Serves static assets + proxies /api/contact → HubSpot Forms API
 *
 * Portal ID : 146667855 (EU1)
 * Form ID   : d668c3ed-f876-48fa-8316-a1f3b38ad81b
 */

const HUBSPOT_PORTAL_ID = "146667855";
const HUBSPOT_FORM_ID   = "d668c3ed-f876-48fa-8316-a1f3b38ad81b";
const HUBSPOT_API_URL   = `https://api.hsforms.com/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${HUBSPOT_FORM_ID}`;

export default {
  async fetch(request, env) {

    const url = new URL(request.url);

    // ── Handle CORS preflight ──────────────────────────────────────
    if (request.method === "OPTIONS" && url.pathname === "/api/contact") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // ── Handle contact form POST ───────────────────────────────────
    if (request.method === "POST" && url.pathname === "/api/contact") {
      return handleContact(request);
    }

    // ── Serve static assets (your existing /dist behaviour) ────────
    return env.ASSETS.fetch(request);
  }
};

// ── Contact handler ────────────────────────────────────────────────
async function handleContact(request) {

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "Invalid request." },
      { status: 400, headers: corsHeaders() }
    );
  }

  const { name, email, phone, message } = body;

  // Basic validation
  if (!name || !name.trim()) {
    return Response.json(
      { ok: false, error: "Please enter your name." },
      { status: 400, headers: corsHeaders() }
    );
  }
  if (!email || !email.trim()) {
    return Response.json(
      { ok: false, error: "Please enter your email address." },
      { status: 400, headers: corsHeaders() }
    );
  }

  // Split name into first / last for HubSpot
  const nameParts = name.trim().split(" ");
  const firstName = nameParts[0];
  const lastName  = nameParts.slice(1).join(" ") || "";

  // Build HubSpot submission payload
  const hsPayload = {
    fields: [
      { name: "firstname", value: firstName },
      { name: "lastname",  value: lastName  },
      { name: "email",     value: email.trim() },
      { name: "phone",     value: phone   ? phone.trim()   : "" },
      { name: "message",   value: message ? message.trim() : "" },
    ],
    context: {
      pageUri:  request.headers.get("Referer") || "https://www.neuralhorizonsai.com",
      pageName: "Contact Form — Neural Horizons AI",
    },
    legalConsentOptions: {
      consent: {
        consentToProcess: true,
        text: "I agree to allow Neural Horizons AI to store and process my personal data.",
      }
    }
  };

  // Forward to HubSpot
  let hsRes;
  try {
    hsRes = await fetch(HUBSPOT_API_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(hsPayload),
    });
  } catch (err) {
    console.error("HubSpot fetch error:", err);
    return Response.json(
      { ok: false, error: "Could not reach HubSpot. Please try again." },
      { status: 502, headers: corsHeaders() }
    );
  }

  if (!hsRes.ok) {
    const errText = await hsRes.text();
    console.error("HubSpot rejected submission:", hsRes.status, errText);
    return Response.json(
      { ok: false, error: "Submission failed. Please try again or email us directly." },
      { status: 502, headers: corsHeaders() }
    );
  }

  // Success
  return Response.json(
    { ok: true, message: "Thank you! We'll be in touch within 24 hours." },
    { status: 200, headers: corsHeaders() }
  );
}

// ── CORS headers ───────────────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "https://www.neuralhorizonsai.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
  };
}
