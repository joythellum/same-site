// Same · upload pipe
// The browser asks this function for signed links, then sends the file bytes straight to
// Cloudflare R2. Nothing heavy passes through Netlify. Works for a 2 MB photo or a 20 GB video.
//
// Needs four environment variables in Netlify (Site settings → Environment variables):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//
// Actions (POST JSON {action, ...}):
//   start    {name, size, type}          → {key, mode:"single", url}  or  {key, mode:"multipart", uploadId, partSize, urls:[...]}
//   complete {key, uploadId, parts}      → {ok, link}   (multipart only)
//   link     {key}                       → {link}       (single-file upload: a 7-day download link)

import { S3Client, PutObjectCommand, GetObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const PART_SIZE = 50 * 1024 * 1024;       // 50 MB parts
const SINGLE_MAX = 90 * 1024 * 1024;      // up to 90 MB goes in one shot
const LINK_DAYS = 7;

function client() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET) {
    throw new Error("R2 is not set up yet: add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET in Netlify.");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function safeName(name) {
  return String(name || "file").replace(/[^\w.\-()\[\] ]+/g, "_").slice(0, 120);
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const Bucket = process.env.R2_BUCKET;
  let s3;
  try { s3 = client(); } catch (e) { return json({ error: e.message }, 500); }

  try {
    if (body.action === "start") {
      const size = Number(body.size || 0);
      const day = new Date().toISOString().slice(0, 10);
      const rand = Math.random().toString(36).slice(2, 8);
      let key = `${day}/${rand}-${safeName(body.name)}`;
      // delivered files (from the done page) go into the order's own folder: delivered/<key>/<name>
      if (body.deliver) {
        const admin = process.env.ADMIN_SECRET && (req.headers.get("x-same-admin") === process.env.ADMIN_SECRET);
        if (!admin) return json({ error: "Not allowed" }, 403);
        if (!/^[a-z0-9]{12,40}$/i.test(String(body.deliver))) return json({ error: "Bad order key" }, 400);
        key = `delivered/${body.deliver}/${safeName(body.name)}`;
      }
      const ContentType = body.type || "application/octet-stream";
      if (size <= SINGLE_MAX) {
        const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket, Key: key, ContentType }), { expiresIn: 3600 });
        return json({ key, mode: "single", url });
      }
      const created = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType }));
      const parts = Math.ceil(size / PART_SIZE);
      const urls = [];
      for (let n = 1; n <= parts; n++) {
        urls.push(await getSignedUrl(s3, new UploadPartCommand({ Bucket, Key: key, UploadId: created.UploadId, PartNumber: n }), { expiresIn: 6 * 3600 }));
      }
      return json({ key, mode: "multipart", uploadId: created.UploadId, partSize: PART_SIZE, urls });
    }

    if (body.action === "complete") {
      const Parts = (body.parts || []).map((p) => ({ PartNumber: Number(p.PartNumber), ETag: String(p.ETag) })).sort((a, b) => a.PartNumber - b.PartNumber);
      await s3.send(new CompleteMultipartUploadCommand({ Bucket, Key: body.key, UploadId: body.uploadId, MultipartUpload: { Parts } }));
      const link = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: body.key }), { expiresIn: LINK_DAYS * 86400 });
      return json({ ok: true, link });
    }

    if (body.action === "abort") {
      await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: body.key, UploadId: body.uploadId }));
      return json({ ok: true });
    }

    if (body.action === "link") {
      const link = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: body.key }), { expiresIn: LINK_DAYS * 86400 });
      return json({ link });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e.message || "Upload service error" }, 500);
  }
};

export const config = { path: "/api/upload" };
