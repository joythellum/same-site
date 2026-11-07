// Same · orders, the "ready" page and the alerts. Free: everything lives in Netlify Blobs.
//
// The browser keeps one secret order key. No account, no password.
//
//   POST /api/order       {k, order, plan, place, name, email, link, brief, files, kind} → saves the order ("working")
//   GET  /api/ready?k=    → {status, readyAt, files:[{name,url,view,size}], plan, place, order, paid, vapid}
//   GET  /api/ready?ping=1 → {ok, r2, push, admin}   (the pages use this to know a real pipe is behind them)
//   POST /api/subscribe   {k, sub}               → saves a push subscription for that order
//   GET  /api/done?list=1                         → (admin) every order, newest first
//   POST /api/done        {k, action:"ready"|"working"|"paid"|"note", note} → (admin) marks the order and buzzes the phones
//   POST /api/done        {claim:"<new password>"}  → sets your admin password, only the first time (or use ADMIN_SECRET)
//
// Optional environment variables: ADMIN_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (all made for you if missing).

import webpush from "web-push";
import { currentUser, saveUser, getUser, normEmail } from "../lib/auth.mjs";
import { mailNewOrder, mailReadyToClient } from "../lib/mail.mjs";
import { store, getJSON, putJSON, json, validKey, isAdmin, adminState, setAdmin, vapidKeys, deliveredFiles, r2Ready } from "../lib/r2.mjs";

const REC = (k) => `orders/${k}.json`;
const etaMinutes = (plan) => (/Everything/.test(plan || "") ? 30 : 60);

async function push() {
  const k = await vapidKeys(webpush);
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:hello@samestudio.co", k.publicKey, k.privateKey);
  return k.publicKey;
}

async function publicView(rec) {
  return {
    k: rec.k, order: rec.order, plan: rec.plan, place: rec.place, created: rec.created, paid: !!rec.paid,
    status: rec.status, readyAt: rec.readyAt || rec.eta, note: rec.note || "", deliveryLink: rec.deliveryLink || "",
    files: rec.status === "ready" ? await deliveredFiles(rec.k) : [],
    vapid: await push(),
  };
}

async function buzz(rec, origin) {
  if (!rec.subs || !rec.subs.length) return 0;
  await push();
  const payload = JSON.stringify({ title: "Same", body: "Your photos are ready. Tap to see them.", url: `${origin}/ready.html?k=${rec.k}` });
  let sent = 0; const keep = [];
  for (const sub of rec.subs) {
    try { await webpush.sendNotification(sub, payload); sent++; keep.push(sub); }
    catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(sub); }
  }
  rec.subs = keep;
  return sent;
}

async function buzzOwner(rec, origin) {
  const cfg = (await getJSON("cfg/owner-subs.json")) || { subs: [] };
  if (!cfg.subs.length) return 0;
  await push();
  const what = rec.link ? "link" : rec.files ? "files" : rec.brief ? "an idea" : "an order";
  const payload = JSON.stringify({ title: "New order · " + (rec.place || "Same"), body: `${rec.plan || ""} · ${rec.name || ""} sent ${what}. Clock is running.`, url: `${origin}/done.html` });
  let sent = 0; const keep = [];
  for (const sub of cfg.subs) {
    try { await webpush.sendNotification(sub, payload); sent++; keep.push(sub); }
    catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(sub); }
  }
  if (keep.length !== cfg.subs.length) await putJSON("cfg/owner-subs.json", { subs: keep });
  return sent;
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const origin = process.env.URL || `${url.protocol}//${url.host}`;

  try {
    if (path.endsWith("/ready") && url.searchParams.get("ping")) {
      const a = await adminState();
      return json({ ok: true, r2: true, bigFiles: r2Ready(), push: true, admin: a.set, vapid: await push() });
    }

    if (path.endsWith("/order") && req.method === "POST") {
      const b = await req.json();
      if (b.action === "owner-sub") {
        if (!b.sub || !b.sub.endpoint) return json({ error: "Bad subscription" }, 400);
        const cfg = (await getJSON("cfg/owner-subs.json")) || { subs: [] };
        cfg.subs = cfg.subs.filter((x) => x.endpoint !== b.sub.endpoint).concat([b.sub]).slice(-10);
        await putJSON("cfg/owner-subs.json", cfg);
        const sent = await buzzOwner({ place: "Test", plan: "Alerts are on", name: "Same", brief: "x" }, origin);
        return json({ ok: true, sent });
      }
      if (!validKey(b.k)) return json({ error: "Bad key" }, 400);
      if (await getJSON(REC(b.k))) return json({ ok: true, k: b.k });
      const created = Date.now(), cut = (v, n) => String(v || "").slice(0, n);
      const user = await currentUser(req);
      if (user) { b.email = user.email; b.name = b.name || user.name; b.place = b.place || user.brand; }
      const owner = !!(user && user.role === "owner");
      await putJSON(REC(b.k), {
        k: b.k, order: cut(b.order, 40), plan: cut(b.plan, 60), place: cut(b.place, 200), name: cut(b.name, 120), email: cut(b.email, 200),
        link: cut(b.link, 1000), brief: cut(b.brief, 4000), notes: cut(b.notes, 2000), files: cut(b.files, 20000), kind: cut(b.kind || "order", 40),
        created, eta: created + etaMinutes(b.plan) * 60000, status: "working", paid: owner, test: owner, subs: [],
      });
      if (user) { user.orders = [b.k].concat((user.orders || []).filter((x) => x !== b.k)); if (!user.brand && b.place) user.brand = cut(b.place, 200); await saveUser(user); }
      const rec = await getJSON(REC(b.k));
      await Promise.allSettled([buzzOwner(rec, origin), mailNewOrder(rec, origin)]);
      return json({ ok: true, k: b.k, skipPay: owner, account: !!user });
    }

    if (path.endsWith("/ready") && req.method === "GET") {
      const k = url.searchParams.get("k");
      if (!validKey(k)) return json({ error: "No order key" }, 400);
      const rec = await getJSON(REC(k));
      if (!rec) return json({ error: "No order with this key" }, 404);
      return json(await publicView(rec));
    }

    if (path.endsWith("/subscribe") && req.method === "POST") {
      const b = await req.json();
      if (!validKey(b.k) || !b.sub || !b.sub.endpoint) return json({ error: "Bad request" }, 400);
      const rec = await getJSON(REC(b.k));
      if (!rec) return json({ error: "No order with this key" }, 404);
      rec.subs = (rec.subs || []).filter((s) => s.endpoint !== b.sub.endpoint).concat([b.sub]).slice(-10);
      await putJSON(REC(b.k), rec);
      return json({ ok: true, push: true });
    }

    if (path.endsWith("/done")) {
      if (req.method === "GET" && url.searchParams.get("state")) return json(await adminState());
      if (req.method === "POST") {
        const peek = await req.clone().json().catch(() => ({}));
        if (peek.claim) return (await setAdmin(peek.claim)) ? json({ ok: true }) : json({ error: "A password is already set (or it is shorter than 8 characters)." }, 400);
      }
      if (!(await isAdmin(req))) return json({ error: "Wrong password" }, 403);
      if (req.method === "GET") {
        const { blobs } = await store().list({ prefix: "orders/" });
        const list = [];
        for (const o of blobs) { const r = await getJSON(o.key); if (r) list.push({ ...r, subs: (r.subs || []).length }); }
        list.sort((a, b) => b.created - a.created);
        return json({ list: list.slice(0, 80) });
      }
      const b = await req.json();
      if (b.action === "owner") {
        const u = await getUser(normEmail(b.email));
        if (!u) return json({ error: "No account with that email yet. Sign up on the site first." }, 404);
        u.role = "owner"; await saveUser(u);
        return json({ ok: true, owner: u.email });
      }
      if (!validKey(b.k)) return json({ error: "Bad key" }, 400);
      const rec = await getJSON(REC(b.k));
      if (!rec) return json({ error: "No order with this key" }, 404);
      let sent = 0;
      if (b.action === "ready") { rec.status = "ready"; rec.readyAt = Date.now(); sent = await buzz(rec, origin); rec.mailed = await mailReadyToClient(rec, origin); }
      else if (b.action === "working") { rec.status = "working"; rec.readyAt = null; }
      else if (b.action === "note") rec.note = String(b.note || "").slice(0, 500);
      else if (b.action === "delivery") rec.deliveryLink = String(b.link || "").slice(0, 1000);
      else if (b.action === "paid") rec.paid = true;
      await putJSON(REC(b.k), rec);
      return json({ ok: true, status: rec.status, sent, mailed: !!rec.mailed, files: (await deliveredFiles(rec.k)).length });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: e.message || "Order service error" }, 500);
  }
};

export const config = { path: ["/api/order", "/api/ready", "/api/subscribe", "/api/done"] };
