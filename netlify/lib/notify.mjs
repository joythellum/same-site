// Same · phone buzzes (web push). Free: keys are made once and kept in Blobs.
import webpush from "web-push";
import { getJSON, putJSON, vapidKeys } from "./r2.mjs";
import { mailReadyToClient } from "./mail.mjs";

export async function pushKey() {
  const k = await vapidKeys(webpush);
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:hello@samestudio.co", k.publicKey, k.privateKey);
  return k.publicKey;
}

async function sendAll(subs, payload) {
  await pushKey();
  let sent = 0; const keep = [];
  for (const sub of subs || []) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload)); sent++; keep.push(sub); }
    catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(sub); }
  }
  return { sent, keep };
}

// the client's devices that asked for an alert on this order
export async function buzzClient(rec, origin) {
  if (!rec.subs || !rec.subs.length) return 0;
  const { sent, keep } = await sendAll(rec.subs, { title: "Same", body: "Your photos are ready. Tap to see them.", url: `${origin}/account.html` });
  rec.subs = keep;
  return sent;
}

// your devices (turned on from done.html)
export async function buzzOwner(title, body, url) {
  const cfg = (await getJSON("cfg/owner-subs.json")) || { subs: [] };
  if (!cfg.subs.length) return 0;
  const { sent, keep } = await sendAll(cfg.subs, { title, body, url });
  if (keep.length !== cfg.subs.length) await putJSON("cfg/owner-subs.json", { subs: keep });
  return sent;
}

// flip an order to ready: buzz the client's devices and email them
export async function markReady(rec, origin) {
  rec.status = "ready"; rec.stage = "ready"; rec.readyAt = Date.now();
  const sent = await buzzClient(rec, origin);
  rec.mailed = await mailReadyToClient(rec, origin);
  return sent;
}
