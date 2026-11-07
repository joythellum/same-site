// Same · accounts and "Your space"
//   POST /api/account/signup  {email, password, name, brand, keys?}  → creates the account, logs in, attaches orders this browser already knows
//   POST /api/account/login   {email, password, keys?}              → logs in
//   POST /api/account/logout                                       → logs out
//   GET  /api/account                                              → {user, orders:[...newest first]} or {user:null}
import { json, getJSON, validKey, deliveredFiles } from "../lib/r2.mjs";
import { createUser, checkPassword, newSession, endSession, currentUser, saveUser, sessionCookie, clearCookie, publicUser } from "../lib/auth.mjs";
import { mailWelcome } from "../lib/mail.mjs";

const withCookie = (body, cookie, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": cookie } });

async function attach(u, keys) {
  let changed = false;
  for (const k of (keys || []).slice(0, 30)) {
    if (!validKey(k) || u.orders.includes(k)) continue;
    const rec = await getJSON(`orders/${k}.json`);
    if (rec && (!rec.email || rec.email.toLowerCase() === u.email)) { u.orders.unshift(k); changed = true; }
  }
  if (changed) await saveUser(u);
}

async function ordersOf(u) {
  const out = [];
  for (const k of u.orders || []) {
    const r = await getJSON(`orders/${k}.json`);
    if (!r) continue;
    out.push({ k, order: r.order, plan: r.plan, place: r.place, kind: r.kind, link: r.link, brief: r.brief, created: r.created, status: r.status,
      readyAt: r.readyAt || r.eta, paid: !!r.paid, test: !!r.test, deliveryLink: r.deliveryLink || "", files: r.status === "ready" ? await deliveredFiles(k) : [] });
  }
  return out.sort((a, b) => b.created - a.created);
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const origin = process.env.URL || `${url.protocol}//${url.host}`;
  try {
    if (path === "/api/account" && req.method === "GET") {
      const u = await currentUser(req);
      if (!u) return json({ user: null });
      return json({ user: publicUser(u), orders: await ordersOf(u) });
    }
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    if (path.endsWith("/logout")) { await endSession(req); return withCookie({ ok: true }, clearCookie()); }
    const b = await req.json().catch(() => ({}));
    if (path.endsWith("/signup")) {
      const u = await createUser(b);
      await attach(u, b.keys);
      const token = await newSession(u.email);
      mailWelcome(u, origin).catch(() => {});
      return withCookie({ ok: true, user: publicUser(u) }, sessionCookie(token));
    }
    if (path.endsWith("/login")) {
      const u = await checkPassword(b.email, b.password);
      if (!u) return json({ error: "Email or password is wrong." }, 401);
      await attach(u, b.keys);
      return withCookie({ ok: true, user: publicUser(u) }, sessionCookie(await newSession(u.email)));
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: e.message || "Account error" }, 400);
  }
};

export const config = { path: ["/api/account", "/api/account/signup", "/api/account/login", "/api/account/logout"] };
