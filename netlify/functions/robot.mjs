// Same · the robot's door. The robot is a scheduled Claude task that runs every 15 minutes (or hourly)
// and does the editing in Higgsfield. This function does the parts that need the open internet:
// grabbing photos from a client's link, saving the edited results, and telling everyone.
//
//   POST /api/robot/init                         → makes the robot key once (returns it once); 403 after that
//   GET  /api/robot?queue=1                      → orders the robot should look at
//   POST /api/robot {action:"harvest", k}        → grabs photos from the order's link (time-boxed: call again until done:true)
//   POST /api/robot {action:"ask", k, credits, photos} → asks you to approve (email + buzz), stage "awaiting"
//   POST /api/robot {action:"stage", k, stage, note?}
//   POST /api/robot {action:"import", k, url, name}    → fetches an edited result and puts it in the client's delivery
//   POST /api/robot {action:"ready", k}          → done: client buzz + email, lands in their space
//   POST /api/robot {action:"fail", k, note}     → tells you something needs a human
//   GET  /api/approve?k=&t=                      → the Approve button in your email (no password needed, one secret per order)
// The robot sends header  x-same-robot: <robot key>

import JSZip from "jszip";
import { randomBytes } from "node:crypto";
import { store, getJSON, putJSON, json, validKey, fileLink, putFile, safeName, rand, BLOB_MAX } from "../lib/r2.mjs";
import { buzzOwner, markReady } from "../lib/notify.mjs";
import { send, ownerEmail } from "../lib/mail.mjs";

const REC = (k) => `orders/${k}.json`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const MAX_ITEMS = 40;
const IMG_EXT = /\.(jpe?g|png|webp|heic|heif|avif|gif)(\?|$)/i, VID_EXT = /\.(mp4|mov|m4v|webm)(\?|$)/i;

async function isRobot(req) {
  const cfg = await getJSON("cfg/robot.json");
  const given = req.headers.get("x-same-robot") || "";
  return !!(cfg && cfg.key && given && given === cfg.key);
}

/* ---------- finding the photos behind a link ---------- */
const abs = (u, base) => { try { return new URL(u.replace(/&amp;/g, "&"), base).toString(); } catch { return null; } };

async function listItems(link) {
  const href = /^https?:\/\//i.test(link) ? link : "https://" + link;
  const u = new URL(href);
  const host = u.hostname.replace(/^www\./, "");

  if (host === "drive.google.com" || host === "docs.google.com") {
    const folder = (u.pathname.match(/\/folders\/([\w-]+)/) || [])[1] || (/folder/.test(u.pathname) ? u.searchParams.get("id") : null);
    const file = (u.pathname.match(/\/file\/d\/([\w-]+)/) || [])[1] || (!folder ? u.searchParams.get("id") : null);
    if (folder) {
      const html = await (await fetch(`https://drive.google.com/embeddedfolderview?id=${folder}`, { headers: { "user-agent": UA } })).text();
      const items = [], seen = new Set();
      for (const m of html.matchAll(/<a href="https:\/\/drive\.google\.com\/file\/d\/([\w-]+)\/view[^"]*"[\s\S]*?class="flip-entry-title">([^<]*)</g)) {
        if (seen.has(m[1])) continue; seen.add(m[1]);
        items.push({ url: `https://drive.google.com/uc?export=download&id=${m[1]}`, name: m[2].trim() || m[1] });
      }
      if (!items.length) for (const m of html.matchAll(/(?:file\/d\/|entry-)([\w-]{20,})/g)) { if (seen.has(m[1])) continue; seen.add(m[1]); items.push({ url: `https://drive.google.com/uc?export=download&id=${m[1]}`, name: m[1] }); }
      if (!items.length) throw new Error("The Drive folder is empty or not shared. Ask the client to set it to 'Anyone with the link'.");
      return { kind: "drive", items };
    }
    if (file) return { kind: "drive", items: [{ url: `https://drive.google.com/uc?export=download&id=${file}`, name: file }] };
  }

  if (host.endsWith("dropbox.com")) {
    u.searchParams.set("dl", "1");
    if (/\/(scl\/fo|sh)\//.test(u.pathname)) return { kind: "dropbox-zip", items: [{ url: u.toString(), name: "dropbox.zip", zip: true }] };
    return { kind: "dropbox", items: [{ url: u.toString(), name: decodeURIComponent(u.pathname.split("/").pop() || "photo") }] };
  }

  if (/wetransfer\.com|we\.tl/.test(host)) throw new Error("WeTransfer links expire and hide their files from robots. Ask for a Google Drive or Dropbox folder.");

  if (IMG_EXT.test(u.pathname) || VID_EXT.test(u.pathname)) return { kind: "direct", items: [{ url: href, name: decodeURIComponent(u.pathname.split("/").pop()) }] };

  // any web page (website, Google profile, a public post): take the big pictures on it
  const res = await fetch(href, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow" });
  const html = await res.text();
  const found = [];
  const add = (x) => { const a = x && abs(x, res.url || href); if (a && !found.includes(a) && !/sprite|icon|logo|favicon|avatar|pixel|blank|1x1/i.test(a)) found.push(a); };
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["'][^>]*content=["']([^"']+)/gi)) add(m[1]);
  for (const m of html.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<img[^>]+?(?:data-src|data-lazy-src|src)=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/srcset=["']([^"']+)["']/gi)) { const best = m[1].split(",").map((s) => s.trim().split(/\s+/)).sort((a, b) => parseInt(b[1] || 0) - parseInt(a[1] || 0))[0]; if (best) add(best[0]); }
  for (const m of html.matchAll(/url\(["']?(https?:[^"')]+\.(?:jpe?g|png|webp))["']?\)/gi)) add(m[1]);
  // one copy per picture: galleries ship the same photo as 370-x.jpg, 480-x.jpg, 1024-x.jpg or x-300x200.jpg; keep the biggest
  const sizeOf = (f) => Math.max(0, ...[...f.matchAll(/(?:^|[-_x])(\d{2,4})(?=[-_x.]|$)/g)].map((m) => parseInt(m[1])));
  const bare = (f) => f.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/^\d{2,4}[-_]/, "").replace(/[-_]\d{2,4}x\d{2,4}$/, "").replace(/[-_](?:\d{2,4}w?|thumb|small|medium|large|scaled)$/i, "");
  const best = new Map();
  for (const x of found.filter((x) => !/\.svg(\?|$)/i.test(x))) {
    const f = decodeURIComponent(new URL(x).pathname.split("/").pop() || ""), k = (bare(f) || f).toLowerCase();
    const cur = best.get(k);
    if (!cur || sizeOf(f) > cur.size) best.set(k, { url: x, name: f || `photo-${best.size + 1}`, size: sizeOf(f) });
  }
  const items = [...best.values()].slice(0, MAX_ITEMS * 2).map(({ url, name }) => ({ url, name, web: true }));
  if (!items.length) throw new Error(/instagram\.com|facebook\.com|tiktok\.com/.test(host) ? "Instagram, Facebook and TikTok block robots. Ask the client for a Drive folder or to upload the files." : "No pictures found on that page.");
  return { kind: "web", items };
}

function extFor(type, name) {
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  const e = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic", "video/mp4": ".mp4", "video/quicktime": ".mov" }[type] || "";
  return name + e;
}

async function saveMedia(rec, buf, name, type) {
  const clean = safeName(extFor(type, name)).slice(0, 100);
  const key = `up/${new Date().toISOString().slice(0, 10)}/${rand(16)}-${clean}`;
  await putFile(key, buf, clean, type);
  rec.media = rec.media || [];
  rec.media.push({ name: clean, key, type, size: buf.byteLength });
}

async function harvest(rec, budgetMs = 7000) {
  const t0 = Date.now();
  if (!rec.link) return { done: true, count: (rec.media || []).length, note: "No link on this order." };
  if (!rec.harvest) {
    try { const l = await listItems(rec.link); rec.harvest = { kind: l.kind, items: l.items, i: 0, skipped: 0 }; }
    catch (e) { rec.harvest = { error: e.message, items: [], i: 0 }; return { done: true, count: (rec.media || []).length, error: e.message }; }
  }
  const h = rec.harvest;
  while (h.i < h.items.length && (rec.media || []).length < MAX_ITEMS && Date.now() - t0 < budgetMs) {
    const it = h.items[h.i++];
    try {
      const r = await fetch(it.url, { headers: { "user-agent": UA }, redirect: "follow" });
      if (!r.ok) { h.skipped++; continue; }
      const type = (r.headers.get("content-type") || "").split(";")[0].trim();
      const len = Number(r.headers.get("content-length") || 0);
      if (it.zip) {
        const zip = await JSZip.loadAsync(await r.arrayBuffer());
        for (const f of Object.values(zip.files)) {
          if (f.dir || !(IMG_EXT.test(f.name) || VID_EXT.test(f.name)) || /__MACOSX/.test(f.name)) continue;
          const buf = await f.async("arraybuffer");
          if (buf.byteLength > BLOB_MAX) { h.skipped++; continue; }
          await saveMedia(rec, buf, f.name.split("/").pop(), IMG_EXT.test(f.name) ? "image/jpeg" : "video/mp4");
          if (rec.media.length >= MAX_ITEMS) break;
        }
        continue;
      }
      if (!/^(image|video)\//.test(type) && !(type === "application/octet-stream" || type === "binary/octet-stream")) { h.skipped++; continue; }
      if (len > BLOB_MAX) { h.skipped++; h.tooBig = (h.tooBig || 0) + 1; continue; }
      const buf = await r.arrayBuffer();
      if (buf.byteLength > BLOB_MAX) { h.skipped++; h.tooBig = (h.tooBig || 0) + 1; continue; }
      if (it.web && buf.byteLength < 25 * 1024) { h.skipped++; continue; }   // icons and thumbnails
      const cd = r.headers.get("content-disposition") || "";
      const nm = (cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i) || [])[1];
      await saveMedia(rec, buf, nm ? decodeURIComponent(nm) : it.name, type.startsWith("image/") || type.startsWith("video/") ? type : "image/jpeg");
    } catch { h.skipped++; }
  }
  const done = h.i >= h.items.length || (rec.media || []).length >= MAX_ITEMS;
  return { done, count: (rec.media || []).length, left: h.items.length - h.i, skipped: h.skipped, tooBig: h.tooBig || 0, kind: h.kind };
}

/* ---------- the door ---------- */
const page = (title, line) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="margin:0;background:#f4e9e1;font-family:Helvetica,Arial,sans-serif;color:#0d0d0d;display:grid;place-items:center;min-height:100vh;padding:24px"><div style="max-width:460px;background:#1be349;border-radius:28px;padding:30px 26px"><div style="font:800 30px/1.05 Arial Black,Helvetica,Arial,sans-serif">${title}</div><p style="font-size:16px;line-height:1.5">${line}</p><a href="/done.html" style="display:inline-block;margin-top:8px;background:#0d0d0d;color:#f4e9e1;text-decoration:none;font-weight:700;padding:14px 24px;border-radius:100px">Open your done page</a></div></body>`, { headers: { "content-type": "text/html; charset=utf-8" } });

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const origin = process.env.URL || `${url.protocol}//${url.host}`;
  try {
    if (path === "/api/approve") {
      const k = url.searchParams.get("k"), t = url.searchParams.get("t");
      const rec = validKey(k) && (await getJSON(REC(k)));
      if (!rec || !rec.approveToken || rec.approveToken !== t) return page("Link not valid", "This approve link is old or wrong. Open your done page instead.");
      if (rec.status !== "ready" || url.searchParams.get("again")) { rec.status = "working"; rec.stage = "approved"; rec.approvedAt = Date.now(); rec.approvedBy = "email"; await putJSON(REC(k), rec); }
      return page("Approved. Claude is on it.", `Order ${rec.order || ""} for ${rec.place || "this brand"}. Claude picks it up on its next round, within about 15 minutes, edits it in Higgsfield and puts it in the client's space. You get a ping when it's done.`);
    }

    if (path === "/api/robot/init" && req.method === "POST") {
      if (await getJSON("cfg/robot.json")) return json({ error: "The robot already has a key." }, 403);
      const key = randomBytes(24).toString("hex");
      await putJSON("cfg/robot.json", { key, at: Date.now() });
      return json({ ok: true, key });
    }

    if (!(await isRobot(req))) return json({ error: "Not allowed" }, 403);

    if (req.method === "GET" && url.searchParams.get("queue")) {
      const { blobs } = await store().list({ prefix: "orders/" });
      const out = [];
      for (const o of blobs) {
        const r = await getJSON(o.key);
        if (!r || r.status === "ready" || !["new", "collected", "approved", "processing"].includes(r.stage || "new")) continue;
        const media = [];
        for (const m of r.media || []) media.push({ name: m.name, type: m.type || "", url: new URL(await fileLink(m.key), origin).toString() });
        out.push({ k: r.k, order: r.order, stage: r.stage || "new", place: r.place, name: r.name, kind: r.kind, link: r.link, brief: r.brief, notes: r.notes,
          created: r.created, approvedAt: r.approvedAt || null, approvedBy: r.approvedBy || "", test: !!r.test, media, harvestError: r.harvest && r.harvest.error || "" });
      }
      out.sort((a, b) => a.created - b.created);
      return json({ now: Date.now(), queue: out });
    }

    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const b = await req.json();
    if (!validKey(b.k)) return json({ error: "Bad key" }, 400);
    const rec = await getJSON(REC(b.k));
    if (!rec) return json({ error: "No order with this key" }, 404);
    let out = { ok: true };

    if (b.action === "harvest") {
      out = await harvest(rec);
      if (out.done && rec.stage === "new") rec.stage = "collected";
    } else if (b.action === "ask") {
      rec.stage = "awaiting"; rec.estimate = Number(b.credits) || 0; rec.approveToken = rec.approveToken || randomBytes(16).toString("hex");
      const n = Number(b.photos) || (rec.media || []).length;
      const link = `${origin}/api/approve?k=${rec.k}&t=${rec.approveToken}`;
      await Promise.allSettled([
        buzzOwner(`Approve · ${rec.place || rec.order}`, `${n} photos, about ${rec.estimate} credits. Tap to approve.`, link),
        send({ to: ownerEmail(), subject: `Approve ${n} photos · ${rec.place || rec.order} · ~${rec.estimate} credits`, title: `${n} photos are waiting.`,
          html: `${rec.name || "A client"} (${rec.place || "no brand"}) sent ${rec.link ? "a link" : "files"}. The robot found <b>${n} photos</b>. Editing them costs about <b>${rec.estimate} Higgsfield credits</b>.<br><br>Tap approve and the robot starts on its next round.`,
          button: { label: `Approve ~${rec.estimate} credits`, url: link } }),
      ]);
      out.approveLink = link;
    } else if (b.action === "stage") {
      const st = String(b.stage || rec.stage);
      if (st === "approved") return json({ error: "Only Llum can approve, from his email or done page." }, 403);
      rec.stage = st; if (b.note) rec.note = String(b.note).slice(0, 500);
    } else if (b.action === "import") {
      const r = await fetch(String(b.url), { headers: { "user-agent": UA } });
      if (!r.ok) return json({ error: `Could not fetch the result (HTTP ${r.status})` }, 502);
      const type = (r.headers.get("content-type") || "image/png").split(";")[0];
      const name = safeName(String(b.name || "same-edit.png")).slice(0, 100);
      await putFile(`delivered/${rec.k}/${name}`, await r.arrayBuffer(), name, type);
      out.saved = name;
    } else if (b.action === "ready") {
      out.sent = await markReady(rec, origin); out.mailed = !!rec.mailed;
    } else if (b.action === "fail") {
      rec.stage = "help"; rec.note = String(b.note || "The robot needs a human.").slice(0, 500);
      await Promise.allSettled([buzzOwner(`Needs you · ${rec.place || rec.order}`, rec.note, `${origin}/done.html`), send({ to: ownerEmail(), subject: `Needs you · ${rec.place || rec.order}`, title: "The robot needs you.", html: rec.note, button: { label: "Open your done page", url: `${origin}/done.html` } })]);
    } else return json({ error: "Unknown action" }, 400);

    await putJSON(REC(b.k), rec);
    return json({ ...out, stage: rec.stage, media: (rec.media || []).length });
  } catch (e) {
    return json({ error: e.message || "Robot error" }, 500);
  }
};

export const config = { path: ["/api/robot", "/api/robot/init", "/api/approve"] };
