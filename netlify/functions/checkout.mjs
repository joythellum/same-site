// Same · payment
// POST {plan, email, place, order}  → creates a Stripe Checkout session, returns {url}
// GET  ?session=cs_...               → tells the thanks page whether that session was paid
//
// Needs one environment variable in Netlify: STRIPE_SECRET_KEY (starts with sk_live_ or sk_test_)

import Stripe from "stripe";
import { getJSON, putJSON } from "../lib/r2.mjs";

const PLANS = {
  "Everything $500": { amount: 50000, name: "Same · Everything", description: "Up to 100 photos in 30 minutes, 6 clips, preview, listing audit, seasonal cover, WhatsApp line, unlimited fixes for 7 days" },
  "The Set+ $350":   { amount: 35000, name: "Same · The Set+",   description: "Up to 40 photos in 1 hour, 3 clips, preview, cover pick, your look saved" },
  "The Set $100":    { amount: 10000, name: "Same · The Set",    description: "Up to 15 photos in 1 hour, sized for every platform" },
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return json({ error: "Payments are not set up yet: add STRIPE_SECRET_KEY in Netlify." }, 500);
  const stripe = new Stripe(key);
  const origin = req.headers.get("origin") || process.env.URL || "";

  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("session");
    if (!id) return json({ error: "No session" }, 400);
    try {
      const s = await stripe.checkout.sessions.retrieve(id);
      const k = s.metadata && s.metadata.key;
      if (s.payment_status === "paid" && k) {
        try { const rec = await getJSON(`orders/${k}.json`); if (rec && !rec.paid) { rec.paid = true; rec.paidAt = Date.now(); await putJSON(`orders/${k}.json`, rec); } } catch {}
      }
      return json({ key: k || "", paid: s.payment_status === "paid", amount: s.amount_total, currency: s.currency, email: s.customer_details && s.customer_details.email, plan: s.metadata && s.metadata.plan, order: s.metadata && s.metadata.order });
    } catch (e) { return json({ error: e.message }, 400); }
  }

  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const plan = PLANS[body.plan];
  if (!plan) return json({ error: "Unknown plan" }, 400);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: body.email || undefined,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: plan.amount, product_data: { name: plan.name, description: plan.description } } }],
      metadata: { order: String(body.order || ""), plan: String(body.plan), place: String(body.place || "").slice(0, 400), key: String(body.key || "").slice(0, 40) },
      success_url: `${origin}/${body.page === "idea" ? "idea" : "order"}.html?paid={CHECKOUT_SESSION_ID}&k=${encodeURIComponent(String(body.key || ""))}`,
      cancel_url: `${origin}/${body.page === "idea" ? "idea" : "order"}.html#cancel`,
      payment_intent_data: { description: `Same ${body.order || ""} · ${body.plan} · ${String(body.place || "").slice(0, 80)}` },
    });
    return json({ url: session.url });
  } catch (e) {
    return json({ error: e.message || "Payment error" }, 500);
  }
};

export const config = { path: "/api/checkout" };
