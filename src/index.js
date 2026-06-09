/**
 * Neural Horizons AI — Cloudflare Worker
 * Handles:
 *   POST /api/contact  → contact form → HubSpot
 *   POST /api/audit    → audit form   → HubSpot + personalised redirect
 * Portal: 146667855 (EU1)
 */

const PORTAL_ID       = "146667855";
const CONTACT_FORM_ID = "d668c3ed-f876-48fa-8316-a1f3b38ad81b";
const AUDIT_FORM_ID   = "d668c3ed-f876-48fa-8316-a1f3b38ad81b";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (request.method === "POST" && url.pathname === "/api/contact") {
      return handleContact(request);
    }

    if (request.method === "POST" && url.pathname === "/api/audit") {
      return handleAudit(request);
    }

    return env.ASSETS.fetch(request);
  }
};

// ── /api/contact ────────────────────────────────────────────────────
async function handleContact(request) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ ok: false, error: "Invalid request." }, { status: 400, headers: cors() });
  }

  const { name, email, phone, message } = body;
  if (!name?.trim())  return Response.json({ ok: false, error: "Please enter your name."  }, { status: 400, headers: cors() });
  if (!email?.trim()) return Response.json({ ok: false, error: "Please enter your email." }, { status: 400, headers: cors() });

  const parts = name.trim().split(" ");
  const hsPayload = {
    fields: [
      { name: "firstname", value: parts[0] },
      { name: "lastname",  value: parts.slice(1).join(" ") || "" },
      { name: "email",     value: email.trim() },
      { name: "phone",     value: phone?.trim()   || "" },
      { name: "message",   value: message?.trim() || "" },
    ],
    context: {
      pageUri:  request.headers.get("Referer") || "https://www.neuralhorizonsai.com",
      pageName: "Contact Form — Neural Horizons AI",
    },
    legalConsentOptions: {
      consent: { consentToProcess: true, text: "I agree to allow Neural Horizons AI to store and process my personal data." }
    }
  };

  const hsRes = await toHubSpot(PORTAL_ID, CONTACT_FORM_ID, hsPayload);
  if (!hsRes.ok) return Response.json({ ok: false, error: "Submission failed. Please try again." }, { status: 502, headers: cors() });

  return Response.json({ ok: true, message: "Thank you! We'll be in touch within 24 hours." }, { status: 200, headers: cors() });
}

// ── /api/audit ──────────────────────────────────────────────────────
async function handleAudit(request) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ ok: false, error: "Invalid request." }, { status: 400, headers: cors() });
  }

  const { firstname, email, company, website, company_size, biggest_challenge, annual_revenue } = body;
  if (!firstname?.trim()) return Response.json({ ok: false, error: "Please enter your first name." }, { status: 400, headers: cors() });
  if (!email?.trim())     return Response.json({ ok: false, error: "Please enter your email."      }, { status: 400, headers: cors() });
  if (!company?.trim())   return Response.json({ ok: false, error: "Please enter your company."   }, { status: 400, headers: cors() });

  const challengeLabels = {
    no_leads:     "Not enough qualified leads",
    manual_work:  "Too much manual, repetitive work",
    slow_growth:  "Growth has stalled",
    ai_starting:  "Ready for AI but don't know where to start",
    tool_underuse:"Have AI tools but not getting results",
    silos:        "Teams disconnected — losing deals in the gaps"
  };

  const hsPayload = {
    fields: [
      { name: "firstname", value: firstname.trim() },
      { name: "lastname",  value: "" },
      { name: "email",     value: email.trim() },
      { name: "company",   value: company.trim() },
      { name: "website",   value: website?.trim() || "" },
      { name: "phone",     value: "" },
      { name: "message",   value: `AI Audit Request — Company Size: ${company_size || "N/A"} | Challenge: ${challengeLabels[biggest_challenge] || biggest_challenge || "N/A"} | Revenue: ${annual_revenue || "N/A"}` },
    ],
    context: {
      pageUri:  "https://www.neuralhorizonsai.com/ai-audit/",
      pageName: "Free AI Audit — Neural Horizons AI",
    },
    legalConsentOptions: {
      consent: { consentToProcess: true, text: "I agree to allow Neural Horizons AI to store and process my personal data." }
    }
  };

  await toHubSpot(PORTAL_ID, AUDIT_FORM_ID, hsPayload);

  const params = new URLSearchParams({
    fn: firstname.trim(),
    co: company.trim(),
    ch: biggest_challenge || "",
    sz: company_size || "",
    rv: annual_revenue || ""
  });

  return Response.json({
    ok: true,
    redirect: `/ai-audit/thank-you/?${params.toString()}`
  }, { status: 200, headers: cors() });
}

// ── HubSpot helper ──────────────────────────────────────────────────
async function toHubSpot(portalId, formId, payload) {
  try {
    return await fetch(
      `https://api.hsforms.com/submissions/v3/integration/submit/${portalId}/${formId}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
    );
  } catch (err) {
    console.error("HubSpot error:", err);
    return { ok: false };
  }
}

// ── CORS ────────────────────────────────────────────────────────────
function cors() {
  return {
    "Access-Control-Allow-Origin":  "https://www.neuralhorizonsai.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
  };
}
