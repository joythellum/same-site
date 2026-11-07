// Same · storage, shared by every function.
//
// Free by default: Netlify Blobs (built into every Netlify site, no card, nothing to set up).
// Optional upgrade: Cloudflare R2 for very big videos. Add the four R2_* variables and the upload pipe uses R2 for files.
//
// Layout in the "same" blob store:
//   orders/<key>.json          the order record
//   cfg/*                      server settings made on first use (alert keys, admin password hash)
//   f/<fileKey>                file info {name,size,type,parts}
//   p/<fileKey>/<n>            file bytes, in 4 MB parts (a function can take ~6 MB per request)
// fileKey looks like  up/<date>/<random>-<name>   (client uploads)
//                 or  delivered/<order key>/<name> (finished work)

import { getStore } from "@netlify/blobs";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomBytes } from "node:crypto";

export const PART = 4 * 1024 * 1024;          // 4 MB per part
export const BLOB_MAX = 20 * 1024 * 1024;      // 20 MB per file on the free storage (a function can stream up to ~20 MB back)

export function r2Ready() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);
}
export const storeReady = () => true;          // Blobs always exist on Netlify

export function r2() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  return new S3Client({ region: "auto", endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY } });
}
export const Bucket = () => process.env.R2_BUCKET;

export const store = () => getStore({ name: "same", consistency: "strong" });

export async function getJSON(key) { return (await store().get(key, { type: "json" })) ?? null; }
export async function putJSON(key, obj) { await store().setJSON(key, obj); }

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const validKey = (k) => /^[a-z0-9]{12,40}$/i.test(String(k || ""));
export const safeName = (name) => String(name || "file").replace(/[^\w.\-()\[\] ]+/g, "_").slice(0, 120);
export const rand = (n = 16) => randomBytes(n).toString("hex").slice(0, n);

/* ---------- admin: env ADMIN_SECRET, or a password set on first visit to done.html ---------- */
const hash = (s) => createHash("sha256").update("same·" + String(s)).digest("hex");
export async function adminState() {
  if (process.env.ADMIN_SECRET) return { set: true, env: true };
  const c = await getJSON("cfg/admin.json");
  return { set: !!(c && c.hash), env: false };
}
export async function setAdmin(pw) {
  if (process.env.ADMIN_SECRET) return false;
  const c = await getJSON("cfg/admin.json");
  if (c && c.hash) return false;                 // already claimed
  if (String(pw || "").length < 8) return false;
  await putJSON("cfg/admin.json", { hash: hash(pw), at: Date.now() });
  return true;
}
export async function isAdmin(req) {
  const given = req.headers.get("x-same-admin") || "";
  if (!given) return false;
  if (process.env.ADMIN_SECRET) return given === process.env.ADMIN_SECRET;
  const c = await getJSON("cfg/admin.json");
  return !!(c && c.hash && c.hash === hash(given));
}

/* ---------- alert keys: from env, or made once and kept ---------- */
export async function vapidKeys(webpush) {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) return { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
  let k = await getJSON("cfg/vapid.json");
  if (!k) { k = webpush.generateVAPIDKeys(); await putJSON("cfg/vapid.json", k); }
  return k;
}

/* ---------- files ---------- */
// a download link for a stored file (R2 key or blob key)
export async function fileLink(key, { download = false, name } = {}) {
  if (key.startsWith("r2:")) {
    const k = key.slice(3);
    const extra = download && name ? { ResponseContentDisposition: `attachment; filename="${name.replace(/"/g, "")}"` } : {};
    return getSignedUrl(r2(), new GetObjectCommand({ Bucket: Bucket(), Key: k, ...extra }), { expiresIn: 7 * 86400 });
  }
  return `/api/file?key=${encodeURIComponent(key)}${download ? "&dl=1" : ""}`;
}

// every finished file for an order, from both places
export async function deliveredFiles(orderKey) {
  const out = [];
  const pre = `f/delivered/${orderKey}/`;
  const { blobs } = await store().list({ prefix: pre });
  for (const b of blobs) {
    const info = await getJSON(b.key);
    if (!info || !info.done) continue;
    const key = b.key.slice(2);
    out.push({ name: info.name, size: info.size, url: await fileLink(key, { download: true, name: info.name }), view: await fileLink(key) });
  }
  if (r2Ready()) {
    const r = await r2().send(new ListObjectsV2Command({ Bucket: Bucket(), Prefix: `delivered/${orderKey}/` }));
    for (const o of r.Contents || []) {
      const name = o.Key.split("/").pop(); if (!name) continue;
      out.push({ name, size: o.Size, url: await fileLink("r2:" + o.Key, { download: true, name }), view: await fileLink("r2:" + o.Key) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// store bytes we fetched ourselves (robot harvest, edited results) as a finished file
export async function putFile(key, buf, name, type) {
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength > BLOB_MAX) throw new Error(`${name} is over 20 MB`);
  const parts = Math.max(1, Math.ceil(bytes.byteLength / PART));
  const s = store();
  for (let i = 0; i < parts; i++) await s.set(`p/${key}/${i}`, bytes.slice(i * PART, (i + 1) * PART).buffer);
  await putJSON("f/" + key, { name, size: bytes.byteLength, type: type || "application/octet-stream", parts, done: true, at: Date.now() });
  return key;
}
