// Same · free file storage (Netlify Blobs)
//   PUT /api/file?key=<fileKey>&part=<n>   stores one 4 MB part (delivered/... needs the admin header)
//   GET /api/file?key=<fileKey>[&dl=1]     streams the whole file back
// The file keys hold a long random part or the secret order key, so they can't be guessed.

import { store, getJSON, json, isAdmin, PART } from "../lib/r2.mjs";

const okKey = (k) => /^(up\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}-[\w.\-()\[\] ]{1,120}|delivered\/[a-z0-9]{12,40}\/[\w.\-()\[\] ]{1,120})$/i.test(k || "");

export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  if (!okKey(key)) return json({ error: "Bad file key" }, 400);
  const info = await getJSON("f/" + key);
  if (!info) return json({ error: "No such file" }, 404);

  if (req.method === "PUT") {
    if (key.startsWith("delivered/") && !(await isAdmin(req))) return json({ error: "Not allowed" }, 403);
    if (info.done) return json({ error: "File already complete" }, 409);
    const n = Number(url.searchParams.get("part"));
    if (!Number.isInteger(n) || n < 0 || n >= info.parts) return json({ error: "Bad part" }, 400);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > PART + 1024) return json({ error: "Part too big" }, 413);
    await store().set(`p/${key}/${n}`, buf);
    return json({ ok: true }, 200);
  }

  if (req.method === "GET") {
    if (!info.done) return json({ error: "Still uploading" }, 409);
    const s = store();
    let i = 0;
    const body = new ReadableStream({
      async pull(ctrl) {
        if (i >= info.parts) { ctrl.close(); return; }
        const b = await s.get(`p/${key}/${i++}`, { type: "arrayBuffer" });
        if (!b) { ctrl.error(new Error("missing part")); return; }
        ctrl.enqueue(new Uint8Array(b));
      },
    });
    const h = { "content-type": info.type || "application/octet-stream", "cache-control": "private, max-age=3600" };
    if (info.size) h["content-length"] = String(info.size);
    if (url.searchParams.get("dl")) h["content-disposition"] = `attachment; filename="${String(info.name).replace(/"/g, "")}"`;
    return new Response(body, { status: 200, headers: h });
  }

  return json({ error: "GET or PUT" }, 405);
};

export const config = { path: "/api/file" };
