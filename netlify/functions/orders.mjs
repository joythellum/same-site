// Same · orders, the "ready" page and the alerts
//
// The browser keeps one secret order key. No account, no password.
//
//   POST /api/order      {k, order, plan, place, name, email, link, brief, files}   → saves the order (status "working")
//   GET  /api/ready?k=   → {status, readyAt, files:[{name,url,size}], plan, place, order, paid, vapid}
//   GET  /api/ready?ping=1 → {ok:true}   (the pages use this to know a real pipe is behind them)
//   POST /api/subscribe  {k, sub}        → saves a push subscription for that order
//   GET  /api/done?list=1                → (admin) every order, newest first
//   POST /api/done       {k, action:"ready"|"working"|"note", note}  → (admin) marks the order and buzzes the phones
//
// Environment variables in Netlify:
//   R2_* (same four as the upload pipe)
//   ADMIN_SECRET                 a long password only you know (the done page asks for it once)
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT   for push alerts (see SETUP.md)

import webpush from "web-push";
import { r2Ready, getJSON, putJSON, listPrefix, signGet, json, validKey, isAdmin } from "../lib/r2.mjs";

const REC = (k) => `orders/${k}.json`;
const DELIVERED = (k) => `delivered/${k}/`;
const LINK_DAYS = 7;

function pushReady() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT || "mailto:hello@samestudio.co", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return true;
}

function etaMinutes(plan) { return /Everything/.test(plan || "") ? 30 : 60; }

async function publicView(rec, origin) {
  const files = [];
  if (rec.status === "ready") {
    const objs = await listPrefix(DELIVERED(rec.k));
    for (const o of objs) {
      const name = o.key.slice(DELIVERED(rec.k).length);
      if (!name) continue;
      files.push({ name, size: o.size, url: await signGet(o.key, LINK_DAYS, name), view: await signGet(o.key, LINK_DAYS) });
    }
  }
  return {
    k: rec.k, order: rec.order, plan: rec.plan, place: rec.place, created: rec.created, paid: !!rec.paid,
    status: rec.status, readyAt: rec.readyAt || rec.eta, note: rec.note || "", files,
    vapid: process.env.VAPID_PUBLIC_KEY || "",
  };
}

async function buzz(rec, origin) {
  if (!pushReady() || !rec.subs || !rec.subs.length) return { sent: 0 };
  const payload = JSON.stringify({ title: "Same", body: "Your photos are ready. Tap to see them.", url: `${origin}/ready.html?k=${rec.k}` });
  let sent = 0; const keep = [];
  for (const sub of rec.subs) {
    try { await webpush.sendNotification(sub, payload); sent++; keep.push(sub); }
    catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(sub); }
  }
  rec.subs = keep;
  return { sent };
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const origin = req.headers.get("origin") || process.env.URL || `${url.protocol}//${url.host}`;

  if (path.endsWith("/ready") && url.searchParams.get("ping")) return json({ ok: true, r2: r2Ready(), push: !!process.env.VAPID_PUBLIC_KEY, admin: !!process.env.ADMIN_SECRET });
  if (!r2Ready()) return json({ error: "Storage is not set up yet: add the R2 variables in Netlify." }, 500);

  try {
    if (path.endsWith("/order") && req.method === "POST") {
      const b = await req.json();
      if (!validKey(b.k)) return json({ error: "Bad key" }, 400);
      const existing = await getJSON(REC(b.k));
      if (existing) return json({ ok: true, k: b.k });
      const created = Date.now();
      const rec = {
        k: b.k, order: String(b.order || "").slice(0, 40), plan: String(b.plan || "").slice(0, 60), place: String(b.place || "").slice(0, 200),
        name: String(b.name || "").slice(0, 120), email: String(b.email || "").slice(0, 200), link: String(b.link || "").slice(0, 1000),
        brief: String(b.brief || "").slice(0, 4000), files: String(b.files || "").slice(0, 20000), kind: String(b.kind || "order").slice(0, 40),
        created, eta: created + etaMinutes(b.plan) * 60000, status: "working", paid: false, subs: [],
      };
      await putJSON(REC(b.k), rec);
      return json({ ok: true, k: b.k });
    }

    if (path.endsWith("/ready") && req.method === "GET") {
      const k = url.searchParams.get("k");
      if (!validKey(k)) return json({ error: "No order key" }, 400);
      const rec = await getJSON(REC(k));
      if (!rec) return json({ error: "No order with this key" }, 404);
      return json(await publicView(rec, origin));
    }

    if (path.endsWith("/subscribe") && req.method === "POST") {
      const b = await req.json();
      if (!validKey(b.k) || !b.sub || !b.sub.endpoint) return json({ error: "Bad request" }, 400);
      const rec = await getJSON(REC(b.k));
      if (!rec) return json({ error: "No order with this key" }, 404);
      rec.subs = (rec.subs || []).filter((s) => s.endpoint !== b.sub.endpoint).concat([b.sub]).slice(-10);
      await putJSON(REC(b.k), rec);
      return json({ ok: true, push: pushReady() });
    }

    if (path.endsWith("/done")) {
      if (!isAdmin(req)) return json({ error: "Not allowed" }, 403);
      if (req.method === "GET") {
        const objs = await listPrefix("orders/");
        const list = [];
        for (const o of objs.sort((a, b) => new Date(b.modified) - new Date(a.modified)).slice(0, 60)) {
          const rec = await getJSON(o.key);
          if (rec) list.push({ k: rec.k, order: rec.order, plan: rec.plan, place: rec.place, name: rec.name, email: rec.email, kind: rec.kind, created: rec.created, eta: rec.eta, status: rec.status, paid: rec.paid, readyAt: rec.readyAt, subs: (rec.subs || []).length, link: rec.link, brief: rec.brief, files: rec.files });
        }
        return json({ list });
      }
      const b = await req.json();
      if (!validKey(b.k)) return json({ error: "Bad key" }, 400);
      const rec = await getJSON(REC(b.k));
      if (!rec) return json({ error: "No order with this key" }, 404);
      let sent = 0;
      if (b.action === "ready") { rec.status = "ready"; rec.readyAt = Date.now(); sent = (await buzz(rec, origin)).sent; }
      else if (b.action === "working") { rec.status = "working"; rec.readyAt = null; }
      else if (b.action === "note") { rec.note = String(b.note || "").slice(0, 500); }
      else if (b.action === "paid") { rec.paid = true; }
      await putJSON(REC(b.k), rec);
      return json({ ok: true, status: rec.status, sent, files: (await publicView(rec, origin)).files.length });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: e.message || "Order service error" }, 500);
  }
};

export const config = { path: ["/api/order", "/api/ready", "/api/subscribe", "/api/done"] };
