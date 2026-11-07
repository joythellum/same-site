// Same · orders, the ready page and your done page. Free: everything lives in Netlify Blobs.
//
//   POST /api/order        {k, order, plan, place, name, email, link, brief, notes, files, kind} → saves the order
//   GET  /api/ready?k=     → the client's view of one order
//   GET  /api/ready?ping=1 → {ok, admin, vapid}   (pages use this to know a real pipe is behind them)
//   POST /api/subscribe    {k, sub}      → a client device that wants the "ready" buzz
//   GET  /api/done?list=1  → (admin) every order, newest first
//   POST /api/done         (admin) {action:"owner-sub", sub} | {action:"owner", email} | {k, action:"approve"|"ready"|"working"|"note"|"delivery"|"paid", ...}
//   POST /api/done         {claim:"<new password>"} → sets your admin password, only the first time
//
// Robot stages on an order: new → collected (photos grabbed) → awaiting (asked you) → approved → processing → ready

import { currentUser, saveUser, getUser, normEmail } from "../lib/auth.mjs";
import { mailNewOrder } from "../lib/mail.mjs";
import { pushKey, buzzOwner, markReady } from "../lib/notify.mjs";
import { store, getJSON, putJSON, json, validKey, isAdmin, adminState, setAdmin, deliveredFiles, fileLink } from "../lib/r2.mjs";

const REC = (k) => `orders/${k}.json`;
const etaMinutes = (plan) => (/Everything/.test(plan || "") ? 30 : 60);

// photos the client uploaded straight to us are already "collected"
function uploadedMedia(files) {
  const out = [];
  for (const line of String(files || "").split("\n")) {
    const m = line.match(/\/api\/file\?key=([^\s&]+)/);
    if (m) { const key = decodeURIComponent(m[1]); out.push({ name: key.split("/").pop().replace(/^[a-f0-9]{16}-/, ""), key }); }
  }
  return out;
}

async function publicView(rec) {
  return {
    k: rec.k, order: rec.order, plan: rec.plan, place: rec.place, created: rec.created, paid: !!rec.paid,
    status: rec.status, stage: rec.stage || "", readyAt: rec.readyAt || rec.eta, note: rec.note || "", deliveryLink: rec.deliveryLink || "",
    files: rec.status === "ready" ? await deliveredFiles(rec.k) : [], vapid: await pushKey(),
  };
}


export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const origin = process.env.URL || `${url.protocol}//${url.host}`;

  try {
    if (path.endsWith("/ready") && url.searchParams.get("ping")) {
      const a = await adminState();
      return json({ ok: true, r2: true, push: true, admin: a.set, vapid: await pushKey() });
    }

    if (path.endsWith("/order") && req.method === "POST") {
      const b = await req.json();
      if (!validKey(b.k)) return json({ error: "Bad key" }, 400);
      if (await getJSON(REC(b.k))) return json({ ok: true, k: b.k });
      const created = Date.now(), cut = (v, n) => String(v || "").slice(0, n);
      const user = await currentUser(req);
      if (user) { b.email = user.email; b.name = b.name || user.name; b.place = b.place || user.brand; }
      const owner = !!(user && user.role === "owner");
      const media = uploadedMedia(b.files);
      const rec = {
        k: b.k, order: cut(b.order, 40), plan: cut(b.plan, 60), place: cut(b.place, 200), name: cut(b.name, 120), email: cut(b.email, 200),
        link: cut(b.link, 1000), brief: cut(b.brief, 4000), notes: cut(b.notes, 2000), files: cut(b.files, 20000), kind: cut(b.kind || "order", 40),
        created, eta: created + etaMinutes(b.plan) * 60000, status: "working", stage: media.length ? "collected" : "new", media,
        paid: owner, test: owner, subs: [],
      };
      await putJSON(REC(b.k), rec);
      if (user) { user.orders = [b.k].concat((user.orders || []).filter((x) => x !== b.k)); if (!user.brand && b.place) user.brand = cut(b.place, 200); await saveUser(user); }
      const what = rec.link ? "a link" : media.length ? `${media.length} files` : rec.brief ? "an idea" : "an order";
      await Promise.allSettled([buzzOwner("New order · " + (rec.place || "Same"), `${rec.name || "Someone"} sent ${what}. The robot is on it.`, `${origin}/done.html`), mailNewOrder(rec, origin)]);
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
        for (const o of blobs) {
          const r = await getJSON(o.key); if (!r) continue;
          const media = [];
          for (const m of (r.media || []).slice(0, 12)) media.push({ name: m.name, url: new URL(await fileLink(m.key), origin).toString() });
          list.push({ ...r, subs: (r.subs || []).length, mediaCount: (r.media || []).length, mediaPreview: media });
        }
        list.sort((a, b) => b.created - a.created);
        return json({ list: list.slice(0, 80) });
      }
      const b = await req.json();
      if (b.action === "owner-sub") {
        if (!b.sub || !b.sub.endpoint) return json({ error: "Bad subscription" }, 400);
        const cfg = (await getJSON("cfg/owner-subs.json")) || { subs: [] };
        cfg.subs = cfg.subs.filter((x) => x.endpoint !== b.sub.endpoint).concat([b.sub]).slice(-10);
        await putJSON("cfg/owner-subs.json", cfg);
        return json({ ok: true, sent: await buzzOwner("Same", "Order alerts are on for this device.", `${origin}/done.html`) });
      }
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
      if (b.action === "ready") sent = await markReady(rec, origin);
      else if (b.action === "approve") { rec.stage = "approved"; rec.approvedAt = Date.now(); }
      else if (b.action === "working") { rec.status = "working"; rec.readyAt = null; if (rec.stage === "ready") rec.stage = "approved"; }
      else if (b.action === "note") rec.note = String(b.note || "").slice(0, 500);
      else if (b.action === "delivery") rec.deliveryLink = String(b.link || "").slice(0, 1000);
      else if (b.action === "paid") rec.paid = true;
      await putJSON(REC(b.k), rec);
      return json({ ok: true, status: rec.status, stage: rec.stage, sent, mailed: !!rec.mailed, files: (await deliveredFiles(rec.k)).length });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: e.message || "Order service error" }, 500);
  }
};

export const config = { path: ["/api/order", "/api/ready", "/api/subscribe", "/api/done"] };
