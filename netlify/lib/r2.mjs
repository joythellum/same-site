// Same · one small door to the R2 bucket, shared by every function.
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function r2Ready() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);
}

export function client() {
  if (!r2Ready()) throw new Error("R2 is not set up yet: add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET in Netlify.");
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  return new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
}

export const Bucket = () => process.env.R2_BUCKET;

export async function getJSON(Key) {
  const s3 = client();
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: Bucket(), Key }));
    const text = await r.Body.transformToString();
    return JSON.parse(text);
  } catch (e) {
    if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function putJSON(Key, obj) {
  const s3 = client();
  await s3.send(new PutObjectCommand({ Bucket: Bucket(), Key, Body: JSON.stringify(obj), ContentType: "application/json" }));
}

export async function listPrefix(Prefix) {
  const s3 = client();
  const out = [];
  let ContinuationToken;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: Bucket(), Prefix, ContinuationToken }));
    (r.Contents || []).forEach((o) => out.push({ key: o.Key, size: o.Size, modified: o.LastModified }));
    ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}

export async function signGet(Key, days = 7, filename) {
  const s3 = client();
  const extra = filename ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"` } : {};
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: Bucket(), Key, ...extra }), { expiresIn: days * 86400 });
}

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// the order key is the only secret a customer holds: letters and digits, 12 to 40 long
export const validKey = (k) => /^[a-z0-9]{12,40}$/i.test(String(k || ""));

export function isAdmin(req) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const given = req.headers.get("x-same-admin") || new URL(req.url).searchParams.get("admin") || "";
  return given === secret;
}
