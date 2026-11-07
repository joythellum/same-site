// Same · upload pipe
// Free by default: files go into Netlify Blobs in 4 MB parts, up to 20 MB per file (every photo, short clips).
// With the four R2_* variables set, files go straight to Cloudflare R2 instead, any size.
//
// POST JSON {action, ...}
//   start    {name, size, type, deliver?}  → blobs: {key, mode:"parts", partSize, parts, url}
//                                            r2:    {key, mode:"single", url} or {key, mode:"multipart", uploadId, partSize, urls}
//   complete {key, uploadId?, parts?}      → {ok, link}
//   link     {key}                         → {link}            (r2 single-file uploads)
//   abort    {key, uploadId}               → {ok}              (r2 multipart)
// deliver:<order key> puts the file in that order's delivered folder (needs the admin header).

import { PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2Ready, r2, Bucket, getJSON, putJSON, json, isAdmin, safeName, rand, fileLink, PART, BLOB_MAX } from "../lib/r2.mjs";

const R2_PART = 50 * 1024 * 1024, R2_SINGLE = 90 * 1024 * 1024;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }

  try {
    if (body.action === "start") {
      const size = Number(body.size || 0), type = String(body.type || "application/octet-stream").slice(0, 100), name = safeName(body.name);
      let key;
      if (body.deliver) {
        if (!(await isAdmin(req))) return json({ error: "Not allowed" }, 403);
        if (!/^[a-z0-9]{12,40}$/i.test(String(body.deliver))) return json({ error: "Bad order key" }, 400);
        key = `delivered/${body.deliver}/${name}`;
      } else {
        key = `up/${new Date().toISOString().slice(0, 10)}/${rand(16)}-${name}`;
      }

      if (r2Ready()) {
        const s3 = r2();
        if (size <= R2_SINGLE) return json({ key: "r2:" + key, mode: "single", url: await getSignedUrl(s3, new PutObjectCommand({ Bucket: Bucket(), Key: key, ContentType: type }), { expiresIn: 3600 }) });
        const created = await s3.send(new CreateMultipartUploadCommand({ Bucket: Bucket(), Key: key, ContentType: type }));
        const urls = [];
        for (let n = 1; n <= Math.ceil(size / R2_PART); n++) urls.push(await getSignedUrl(s3, new UploadPartCommand({ Bucket: Bucket(), Key: key, UploadId: created.UploadId, PartNumber: n }), { expiresIn: 6 * 3600 }));
        return json({ key: "r2:" + key, mode: "multipart", uploadId: created.UploadId, partSize: R2_PART, urls });
      }

      if (size > BLOB_MAX) return json({ error: `"${name}" is ${Math.round(size / 1048576)} MB. Files up to 20 MB upload here; for bigger videos use "Just a link" (Drive, WeTransfer, Dropbox).`, tooBig: true }, 413);
      const parts = Math.max(1, Math.ceil(size / PART));
      await putJSON("f/" + key, { name, size, type, parts, done: false, at: Date.now() });
      return json({ key, mode: "parts", partSize: PART, parts, url: `/api/file?key=${encodeURIComponent(key)}` });
    }

    if (body.action === "complete") {
      const key = String(body.key || "");
      if (key.startsWith("r2:")) {
        const k = key.slice(3);
        const Parts = (body.parts || []).map((p) => ({ PartNumber: Number(p.PartNumber), ETag: String(p.ETag) })).sort((a, b) => a.PartNumber - b.PartNumber);
        await r2().send(new CompleteMultipartUploadCommand({ Bucket: Bucket(), Key: k, UploadId: body.uploadId, MultipartUpload: { Parts } }));
        return json({ ok: true, link: await fileLink(key) });
      }
      const info = await getJSON("f/" + key);
      if (!info) return json({ error: "No such upload" }, 404);
      info.done = true; await putJSON("f/" + key, info);
      return json({ ok: true, link: new URL(await fileLink(key), req.url).toString() });
    }

    if (body.action === "link") return json({ link: await fileLink(String(body.key || "")) });

    if (body.action === "abort" && String(body.key || "").startsWith("r2:")) {
      await r2().send(new AbortMultipartUploadCommand({ Bucket: Bucket(), Key: String(body.key).slice(3), UploadId: body.uploadId }));
      return json({ ok: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e.message || "Upload service error" }, 500);
  }
};

export const config = { path: "/api/upload" };
